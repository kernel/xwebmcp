// A stand-in for the Purelymail webmail (Roundcube) used by the purelymail.com tool tests.
// It answers the same requests the tools make with fabricated accounts, messages and filters;
// nothing here contacts the live site.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export const ACCOUNT = "agent@example.com";
export const NOW = Date.parse("2026-03-10T12:00:00Z");
const ORIGIN = "https://inbox.purelymail.com";

export const plain = value => JSON.parse(JSON.stringify(value));
export const toolSource = name => readFileSync(new URL(`../../../domains/purelymail.com/${name}.js`, import.meta.url), "utf8");

// Validates the JSON Schema keywords the tools use, so every result is checked against its outputSchema.
export function conforms(schema, value) {
  if (schema === true) return true;
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) return false;
    if (schema.properties && Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in (schema.properties || {})))) return false;
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rfcDate = ms => new Date(ms).toUTCString().replace("GMT", "+0000");

// Builds a message source the way Purelymail stores it: its own headers first, then the sender's.
export function mime({ from, to = ACCOUNT, subject, text: bodyText = null, html = null, receivedAt = NOW - 60000, date = receivedAt, auth = null, extraHeaders = [], attachment = null, subjectRaw = null, base64Text = false, received = true }) {
  const text = bodyText === null && html === null ? "" : bodyText;
  const domain = from.replace(/.*@/, "").replace(/>.*/, "");
  const results = auth === null ? `purelymail.com; dkim=pass header.i=${domain}; dmarc=pass (p=reject) header.from=${domain}` : auth;
  const top = [
    "Return-Path: <bounce@" + domain + ">",
    "Delivered-To: " + ACCOUNT,
    ...(results ? ["Authentication-Results: " + results] : []),
    ...(received ? ["Received: from mx.example.net by purelymail.com (Purelymail SMTP) with ESMTPS id x1;", "        " + rfcDate(receivedAt)] : [])
  ];
  const own = [...extraHeaders, "Date: " + rfcDate(date), "Subject: " + (subjectRaw ?? subject), "From: " + from, "To: " + to, "Message-ID: <" + subject.length + "." + receivedAt + "@" + domain + ">", "MIME-Version: 1.0"];
  const textPart = text === null ? null : base64Text
    ? ["Content-Type: text/plain; charset=\"utf-8\"", "Content-Transfer-Encoding: base64", "", Buffer.from(text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n")].join("\r\n")
    : ["Content-Type: text/plain; charset=\"utf-8\"", "Content-Transfer-Encoding: quoted-printable", "", Buffer.from(text, "utf8").toString("latin1").replace(/[=\x80-\xff]/g, c => "=" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))].join("\r\n");
  const htmlPart = html === null ? null : ["Content-Type: text/html; charset=\"utf-8\"", "", html].join("\r\n");
  const parts = [textPart, htmlPart].filter(Boolean);
  let body;
  if (attachment || parts.length > 1) {
    const boundary = "b1_fixture";
    const alternative = parts.length > 1 ? ["Content-Type: multipart/alternative; boundary=\"b2_fixture\"", "", ...parts.flatMap(p => ["--b2_fixture", p]), "--b2_fixture--"].join("\r\n") : parts[0];
    const items = [alternative];
    if (attachment) items.push(["Content-Type: application/pdf; name=\"" + attachment + "\"", "Content-Disposition: attachment; filename=\"" + attachment + "\"", "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-fixture").toString("base64")].join("\r\n"));
    body = ["Content-Type: multipart/mixed; boundary=\"" + boundary + "\"", "", "This is a multi-part message.", ...items.flatMap(p => ["--" + boundary, p]), "--" + boundary + "--", "epilogue"].join("\r\n");
  } else body = parts[0];
  const [bodyHead, ...rest] = body.split("\r\n\r\n");
  return [...top, ...own, bodyHead].join("\r\n") + "\r\n\r\n" + rest.join("\r\n\r\n");
}

export function server(options = {}) {
  const state = {
    account: options.account ?? ACCOUNT,
    loggedIn: options.loggedIn ?? true,
    folders: plain(options.folders ?? [{ id: "INBOX", name: "Inbox", class: "inbox" }, { id: "Drafts", name: "Drafts", class: "drafts" }, { id: "Sent", name: "Sent", class: "sent" }, { id: "Junk", name: "Junk", class: "junk" }, { id: "Trash", name: "Trash", class: "trash" }]),
    messages: plain(options.messages ?? []),
    filters: plain(options.filters ?? []),
    setActive: options.setActive ?? true,
    sent: [],
    requests: [],
    posts: [],
    nextUid: {},
    sendResponse: options.sendResponse ?? "ok",
    saveResponse: options.saveResponse ?? "ok",
    deleteResponse: options.deleteResponse ?? "ok",
    folderResponse: options.folderResponse ?? "ok",
    ignoreSaves: options.ignoreSaves ?? false,
    arrivals: plain(options.arrivals ?? [])
  };
  const clock = { now: options.now ?? NOW };
  const messagesIn = folder => state.messages.filter(m => m.folder === folder).sort((a, b) => options.oldestFirst ? a.uid - b.uid : b.uid - a.uid);
  const who = m => m.fromHtml ?? `<span class="adr"><span title="${esc(m.fromAddress)}" class="rcmContactAddress">${esc(m.fromName ?? m.fromAddress)}</span></span>`;
  const rows = (list, folder) => list.map(m => `this.add_message_row(${m.uid},${JSON.stringify({ subject: esc(m.subject), fromto: who(m), date: "2026-03-10 11:59", size: "4 KB" })},${JSON.stringify({ ...(m.seen ? { seen: 1 } : {}), ...(m.flagged ? { flagged: 1 } : {}), ctype: "text/plain", mbox: folder })},false);`);
  const listJson = (list, folder, page, extraEnv = {}) => {
    const size = 50;
    const slice = list.slice((page - 1) * size, page * size);
    return JSON.stringify({
      action: "list",
      env: { mailbox: folder, messagecount: list.length, pagecount: Math.ceil(list.length / size), current_page: page, ...extraEnv },
      exec: [`this.set_message_coltypes(["threads","subject","status","fromto","date","size","flag","attachment"],null,"${folder === "Sent" || folder === "Drafts" ? "to" : "from"}");`, ...rows(slice, folder), ""].join("\n")
    });
  };
  const searchCache = {};
  const filterForm = (f, fid) => {
    const select = (name, values, selected, extra = "") => `<select name="${name}" ${extra}>` + values.map(v => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v)}</option>`).join("") + "</select>";
    const ta = (name, lines) => `<textarea data-type="list" name="${name}" style="display:none">${esc(lines.join("\n"))}</textarea>`;
    let html = `<form name="filterform" action="./" method="post"><input type="hidden" name="_token" value="tok"><input type="hidden" name="_fid" value="${fid}">`;
    html += `<input name="_name" id="_name" class="form-control" value="${esc(f.name)}" type="text"><input type="checkbox" id="fenabled" name="_enabled" value="1"${f.enabled ? " checked" : ""} />`;
    html += select("_join", ["allof", "anyof", "any"], f.join, 'id="_join"');
    const rules = f.rules.length ? f.rules : [{ header: "subject", op: "contains", targets: [], custom: [], mod: "", comp: "", trans: "text" }];
    rules.forEach((r, i) => {
      html += select(`_header[${i}]`, ["subject", "size", "from", "to", "...", "body", "date"], r.header) + ta(`_custom_header[${i}]`, r.custom || []);
      html += select(`_rule_op[${i}]`, ["contains", "notcontains", "is", "notis", "exists", "notexists", "matches", "notmatches", "count-gt", "value-gt"], r.op) + ta(`_rule_target[${i}]`, r.targets);
      html += select(`_rule_mod[${i}]`, ["", "address", "envelope"], r.mod || "") + select(`_rule_comp[${i}]`, ["", "i;octet"], r.comp || "") + select(`_rule_trans[${i}]`, ["text", "raw", "content"], r.trans || "text");
    });
    f.actions.forEach((a, i) => {
      html += select(`_action_type[${i}]`, ["fileinto", "fileinto_copy", "redirect", "vacation", "discard", "setflag", "addflag", "removeflag", "keep", "stop"], a.type);
      html += select(`_action_mailbox[${i}]`, state.folders.map(x => x.id), a.mailbox || "INBOX", `style="display:${a.type.startsWith("fileinto") ? "inline" : "none"}"`);
      for (const flag of ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"]) html += `<input type="checkbox" name="_action_flags[${i}][]" value="${flag}"${(a.flags || []).includes(flag) ? " checked" : ""}>`;
      html += ta(`_action_flags[${i}]`, a.customFlags || []);
      html += `<textarea name="_action_reason[${i}]">${esc(a.reason || "")}</textarea><input type="text" name="_action_subject[${i}]" value="${esc(a.subject || "")}"><input type="text" name="_action_from[${i}]" value="${esc(a.from || "")}">`;
      html += ta(`_action_addresses[${i}]`, a.addresses || []) + `<input type="text" name="_action_interval[${i}]" value="${esc(a.interval || "")}">` + select(`_action_interval_type[${i}]`, ["days", "seconds"], a.intervalType || "days");
    });
    return html + "</form>";
  };
  // Reads a posted filter form the way the managesieve plugin does.
  const parseSave = params => {
    const all = name => params.getAll(name);
    const get = name => params.get(name);
    const f = { name: get("_name"), enabled: get("_enabled") === "1", join: get("_join"), rules: [], actions: [] };
    for (let i = 0; get(`_header[${i}]`) !== null; i++) {
      f.rules.push({ header: get(`_header[${i}]`), op: get(`_rule_op[${i}]`), targets: all(`_rule_target[${i}][]`).filter(Boolean), custom: all(`_custom_header[${i}][]`).filter(Boolean), mod: get(`_rule_mod[${i}]`), comp: get(`_rule_comp[${i}]`), trans: get(`_rule_trans[${i}]`) });
    }
    if (f.join === "any") f.rules = [];
    for (let i = 0; get(`_action_type[${i}]`) !== null; i++) {
      const type = get(`_action_type[${i}]`);
      f.actions.push({ type, mailbox: get(`_action_mailbox[${i}]`), flags: all(`_action_flags[${i}][]`).filter(Boolean), reason: get(`_action_reason[${i}]`), subject: get(`_action_subject[${i}]`), from: get(`_action_from[${i}]`), addresses: all(`_action_addresses[${i}][]`).filter(Boolean), interval: get(`_action_interval[${i}]`), intervalType: get(`_action_interval_type[${i}]`) });
    }
    return f;
  };
  const html = body => `<!DOCTYPE html><html><head><title></title></head><body>${body}</body></html>`;
  const loginRedirect = { status: 200, url: "https://purelymail.com/user/login", body: html('<form id="loginForm"></form>') };
  const route = (method, url, params) => {
    const u = new URL(url, ORIGIN);
    const q = u.searchParams;
    const task = q.get("_task") || (params && params.get("_task"));
    const action = q.get("_action") || (params && params.get("_action"));
    if (!state.loggedIn) {
      if (q.get("_remote") || (params && params.get("_remote"))) return { status: 200, url: u.href, body: JSON.stringify({ action, exec: 'this.session_error("/?_task=login&_err=session");' }) };
      return loginRedirect;
    }
    if (task === "mail" && !action && method === "GET") {
      const env = { task: "mail", mailboxes: Object.fromEntries(state.folders.map(f => [f.id, { id: f.id, name: f.name, virtual: false, class: f.class }])), delimiter: ".", junk_mailbox: "Junk", trash_mailbox: "Trash", drafts_mailbox: "Drafts" };
      return { status: 200, url: u.href, body: html(`<span class="header-title username">${esc(state.account)}</span><script>var rcmail = new rcube_webmail();rcmail.set_env(${JSON.stringify(env)});</script>`) };
    }
    if (task === "mail" && action === "list") {
      const folder = q.get("_mbox");
      const search = q.get("_search");
      const list = search ? searchCache[search] : messagesIn(folder);
      return { status: 200, url: u.href, body: listJson(list, folder, Number(q.get("_page") || 1)) };
    }
    if (task === "mail" && action === "search") {
      const folder = q.get("_mbox");
      const text = (q.get("_q") || "").toLowerCase();
      const fields = (q.get("_headers") || "").split(",");
      const filter = q.get("_filter");
      const found = messagesIn(folder).filter(m => (!text || fields.some(field => field === "subject" ? m.subject.toLowerCase().includes(text) : field === "from" ? (m.fromAddress + " " + (m.fromName || "")).toLowerCase().includes(text) : m.raw.toLowerCase().includes(text)))
        && (filter !== "UNSEEN" || !m.seen) && (filter !== "FLAGGED" || m.flagged));
      const id = "S" + Object.keys(searchCache).length;
      searchCache[id] = found;
      return { status: 200, url: u.href, body: listJson(found, folder, 1, { search_request: id }) };
    }
    if (task === "mail" && action === "viewsource") {
      const m = state.messages.find(x => x.folder === q.get("_mbox") && x.uid === Number(q.get("_uid")));
      return { status: 200, url: u.href, body: m ? m.raw : "", latin1: true };
    }
    if (task === "mail" && action === "compose") {
      if (options.composeBroken) return { status: 200, url: u.href + "&_id=c1", body: html("<p>nothing</p>") };
      return { status: 200, url: u.href + "&_id=c1", body: html(`<form name="form" method="post" action="/?_task=mail"><input type="hidden" name="_token" value="tok"><input type="hidden" name="_task" value="mail"><input type="hidden" name="_action" value="send"><input type="hidden" name="_id" value="c1"><select name="_from"><option value="7" selected>${esc(state.account)}</option></select><textarea name="_to"></textarea><input type="text" name="_subject" value=""></form><form name="uploadform"><input type="hidden" name="_action" value="upload"></form><select name="_store_target"><option value="">- don't save -</option><option value="INBOX">Inbox</option><option value="Sent" selected>Sent</option></select>`) };
    }
    if (method === "POST" && params && params.get("_action") === "send") {
      if (state.sendResponse === "network") return "network";
      state.sent.push(Object.fromEntries(params));
      if (params.get("_store_target") !== "Sent") return { status: 200, url: u.href, body: html('<script>parent.rcmail.sent_successfully("confirmation","Message sent successfully.",[],false);</script>') };
      if (state.sendResponse === "error") return { status: 200, url: u.href, body: html('<script>parent.rcmail.display_message("SMTP Error (550): Recipient rejected.","error",0);</script>') };
      if (state.sendResponse === "garbage") return { status: 502, url: u.href, body: "Bad gateway" };
      const uid = (state.nextUid.Sent = (state.nextUid.Sent || 100) + 1);
      state.messages.push({ folder: "Sent", uid, seen: true, subject: params.get("_subject"), fromHtml: `<span class="adr"><span title="${esc(params.get("_to"))}" class="rcmContactAddress">${esc(params.get("_to"))}</span></span>`, fromAddress: params.get("_to"), raw: mime({ from: state.account, to: params.get("_to"), subject: params.get("_subject"), text: params.get("_message"), receivedAt: NOW, auth: "purelymail.com; auth=pass" }) });
      return { status: 200, url: u.href, body: html('<script>if (window.parent && parent.rcmail) { parent.rcmail.sent_successfully("confirmation","Message sent successfully.",["Sent"],false); }</script>') };
    }
    if (task === "settings" && action === "plugin.managesieve" && method === "GET") {
      const list = state.filters.map((f, i) => `<tr id="rcmrow${i}"${f.enabled ? "" : ' class="disabled"'}><td class="name">${esc(f.name)}</td></tr>`).join("");
      return { status: 200, url: u.href, body: html(`<table id="filtersetslist"><tbody><tr id="rcmrowS0"${state.setActive ? "" : ' class="disabled"'}><td class="name">roundcube</td></tr></tbody></table><table id="filterslist"><tbody>${list}</tbody></table><script>rcmail.set_env({"filtersets":{"S0":"roundcube"},"currentset":"roundcube"});</script>`) };
    }
    if (task === "settings" && action === "plugin.managesieve-action" && method === "GET") {
      const fid = Number(q.get("_fid"));
      const f = state.filters[fid];
      return { status: 200, url: u.href, body: f ? html(filterForm(f, fid)) : html("<p>error</p>") };
    }
    if (method === "POST" && params && params.get("_action") === "plugin.managesieve-save") {
      if (state.saveResponse === "network") return "network";
      if (state.saveResponse === "error") return { status: 200, url: u.href, body: html('<script>parent.rcmail.display_message("Unable to save filter. Server error occurred.","error",0);</script>') };
      if (state.saveResponse === "silent") return { status: 200, url: u.href, body: html("<p></p>") };
      const f = parseSave(params);
      const fid = params.get("_fid");
      if (!state.ignoreSaves) {
        if (fid === "") state.filters.push(f); else state.filters[Number(fid)] = f;
      }
      return { status: 200, url: u.href, body: html(`<script>parent.rcmail.managesieve_updatelist("${fid === "" ? "add" : "update"}",${JSON.stringify({ name: f.name, id: fid === "" ? state.filters.length - 1 : Number(fid), disabled: !f.enabled })});</script>`) };
    }
    if (method === "POST" && u.searchParams.get("_action") === "plugin.managesieve-action" && params.get("_act") === "delete") {
      if (state.deleteResponse === "network") return "network";
      if (state.deleteResponse === "error") return { status: 200, url: u.href, body: JSON.stringify({ exec: 'this.display_message("Unable to delete filter.","error",0);\n' }) };
      state.filters.splice(Number(params.get("_fid")), 1);
      return { status: 200, url: u.href, body: JSON.stringify({ exec: 'this.display_message("Filter deleted successfully.","confirmation",0);\nthis.managesieve_updatelist("del",{"id":' + params.get("_fid") + "});\n" }) };
    }
    if (method === "POST" && params && params.get("_action") === "save-folder") {
      if (state.folderResponse === "error") return { status: 200, url: u.href, body: html('<script>parent.rcmail.display_message("Unable to create folder.","error",0);</script>') };
      const parent = params.get("_parent");
      const id = parent ? parent + "." + params.get("_name") : params.get("_name");
      state.folders.push({ id, name: params.get("_name"), class: "mailbox" });
      return { status: 200, url: u.href, body: html(`<script>parent.rcmail.add_folder_row(${JSON.stringify(id)},${JSON.stringify(params.get("_name"))},${JSON.stringify(id)},false,true,"mailbox");parent.rcmail.display_message("Folder created successfully.","confirmation",0);</script>`) };
    }
    return { status: 404, url: u.href, body: "not found" };
  };
  const fetch = async (url, init = {}) => {
    for (const arrival of state.arrivals.filter(a => a.at <= clock.now)) state.messages.push(arrival.message);
    state.arrivals = state.arrivals.filter(a => a.at > clock.now);
    const params = init.body ? new URLSearchParams(init.body.toString()) : null;
    state.requests.push({ method: init.method || "GET", url, params: params ? Object.fromEntries(params) : null, headers: init.headers || {} });
    if (init.method === "POST") state.posts.push({ url, params });
    const answer = route(init.method || "GET", url, params);
    if (answer === "network") throw new TypeError("Failed to fetch");
    const bytes = answer.latin1 ? Buffer.from(answer.body, "latin1") : Buffer.from(answer.body, "utf8");
    return { status: answer.status, ok: answer.status < 400, url: answer.url, body: null, text: async () => bytes.toString("utf8"), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  return { state, fetch, clock };
}

// Evaluates a page tool the way the runtime materializes it in the webmail document.
export function pageTool(name, backend, options = {}) {
  const clock = backend.clock;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const origin = options.origin ?? ORIGIN;
  const window = { rcmail: options.noRcmail ? undefined : { env: { request_token: "tok", task: options.task ?? "mail" } } };
  const context = {
    window, fetch: backend.fetch, location: { origin, href: origin + "/?_task=mail", hostname: new URL(origin).hostname },
    document: { querySelector: selector => selector === ".header-title.username" && options.header !== false ? { textContent: " " + backend.state.account + " " } : null },
    URL, URLSearchParams, TextDecoder, atob, unescape, Date: FakeDate,
    setTimeout: (fn, ms) => { clock.now += ms; Promise.resolve().then(fn); return 0; }
  };
  window.window = window;
  const [definition] = runInNewContext(`(${toolSource(name)})`, context);
  return {
    definition, clock,
    run: async input => {
      const result = plain(await definition.execute(input));
      if (!conforms(definition.tool.outputSchema, result)) throw new Error(name + " result does not match its outputSchema: " + JSON.stringify(result).slice(0, 600));
      return result;
    }
  };
}
