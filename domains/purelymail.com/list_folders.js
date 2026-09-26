[{
  kind: "page",
  match: { url_patterns: ["https://inbox.purelymail.com/*"] },
  tool: {
    name: "list_folders",
    description: "List the mail folders of the signed-in Purelymail webmail account: each folder's id (the value other tools take as folder), display name, special role (inbox, drafts, sent, junk, trash, archive or null), and, unless include_counts is false, its total and unread message counts. Only folders the webmail shows (subscribed folders) are listed. Runs on an open https://inbox.purelymail.com/ page; use the login tool first if no webmail page is open. Read-only: changes nothing, marks nothing as read. Returns account, the signed-in address, so the caller can confirm which mailbox it is reading.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { include_counts: { type: "boolean", default: true, description: "Also count total and unread messages per folder (two small requests per folder)." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "folders"],
          properties: {
            status: { const: "ok" },
            account: { type: "string", minLength: 3 },
            folders: { type: "array", items: {
              type: "object", additionalProperties: false, required: ["id", "name", "role", "total", "unread"],
              properties: {
                id: { type: "string", minLength: 1 }, name: { type: "string" },
                role: { enum: ["inbox", "drafts", "sent", "junk", "trash", "archive", null] },
                total: { type: ["integer", "null"], minimum: 0 }, unread: { type: ["integer", "null"], minimum: 0 }
              }
            } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "not_authenticated", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://inbox.purelymail.com";
    const startedAt = Date.now();
    const remaining = () => 110000 - (Date.now() - startedAt);
    const stop = (kind, message) => { const error = new Error(message); error.kind = kind; throw error; };
    const enc = encodeURIComponent;
    const EMAIL = /^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
    const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
    const decodeEntities = value => String(value ?? "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name) => {
      if (name[0] === "#") {
        const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
      }
      return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : match;
    });
    const token = () => (window.rcmail && window.rcmail.env && window.rcmail.env.request_token) || "";
    // Every call is one request the webmail UI itself makes; callers decide whether an unknown outcome may be repeated.
    const request = async (path, { method = "GET", form = null, as = "json", remote = true, maxBytes = 1048576 } = {}) => {
      const headers = {};
      if (remote) headers["X-Roundcube-Request"] = token();
      let body;
      if (form) {
        body = new URLSearchParams();
        for (const [key, value] of form) body.append(key, value);
      }
      let response;
      try {
        response = await fetch(path, { method, headers, body, credentials: "same-origin" });
      } catch {
        return { network_error: true, status: 0, url: "", logged_out: false };
      }
      const out = { status: response.status, url: response.url || "" };
      if (as === "bytes") {
        const chunks = [];
        let total = 0;
        const reader = response.body && response.body.getReader ? response.body.getReader() : null;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.length;
            if (total >= maxBytes) { try { await reader.cancel(); } catch { /* already closed */ } break; }
          }
        } else {
          const all = new Uint8Array(await response.arrayBuffer());
          chunks.push(all);
          total = all.length;
        }
        out.truncated = total > maxBytes || (!!reader && total >= maxBytes);
        let text = "";
        let used = 0;
        for (const chunk of chunks) {
          for (let i = 0; i < chunk.length && used < maxBytes; i += 8192) {
            const part = chunk.subarray(i, Math.min(chunk.length, i + 8192, i + maxBytes - used));
            text += String.fromCharCode.apply(null, part);
            used += part.length;
          }
        }
        out.latin1 = text;
      } else {
        const text = await response.text();
        if (as === "json") {
          try { out.json = JSON.parse(text); } catch { out.json = null; }
        } else out.text = text;
      }
      const exec = out.json && typeof out.json.exec === "string" ? out.json.exec : "";
      const head = (out.text || out.latin1 || "").slice(0, 4000);
      out.logged_out = /session_error\(/.test(exec) || /[?&]_task=login\b/.test(out.url) || /^https:\/\/purelymail\.com\//.test(out.url)
        || (as !== "json" && /id="rcmloginuser"|name="_task" value="login"|id="loginForm"/.test(head));
      return out;
    };
    const NOT_SIGNED_IN = "The webmail session is not signed in or has expired; run the login tool first. Nothing was changed.";
    const ajax = async (path, options) => {
      const result = await request(path, options);
      if (result.network_error) stop("site_error", "A webmail request failed at the network level; nothing was changed by this read.");
      if (result.logged_out) stop("not_authenticated", NOT_SIGNED_IN);
      if (result.status >= 400 || !result.json) stop("site_error", "The webmail answered HTTP " + result.status + " without the expected data.");
      return result.json;
    };
    const execCalls = (exec, name) => String(exec || "").split("\n").filter(line => line.startsWith("this." + name + "(")).map(line => {
      try { return JSON.parse("[" + line.slice(name.length + 6, line.lastIndexOf(")")) + "]"); } catch { return null; }
    }).filter(Boolean);
    const currentAccount = async () => {
      const valid = value => { const v = String(value || "").trim().toLowerCase(); return EMAIL.test(v) ? v : null; };
      const element = document.querySelector(".header-title.username");
      const shown = valid(element && element.textContent);
      if (shown) return shown;
      const page = await request("/?_task=mail&_mbox=INBOX", { as: "text", remote: false });
      if (page.logged_out || page.network_error) return null;
      const match = /class="header-title username">([^<]+)</.exec(page.text || "");
      return match ? valid(decodeEntities(match[1])) : null;
    };
    const requireSession = async () => {
      if (location.origin !== ORIGIN) stop("wrong_page", "This tool runs on the Purelymail webmail at " + ORIGIN + "/ ; run the login tool, which opens it. Nothing was changed.");
      if (!token() || (window.rcmail.env && window.rcmail.env.task === "login")) stop("not_authenticated", NOT_SIGNED_IN);
      const account = await currentAccount();
      if (!account) stop("not_authenticated", NOT_SIGNED_IN);
      return account;
    };
    const failure = error => error && error.kind
      ? { status: "error", error_kind: error.kind, error_message: error.message }
      : { status: "error", error_kind: "site_error", error_message: "Unexpected failure: " + String((error && error.message) || error).slice(0, 200) };
    const people = html => {
      const out = [];
      for (const match of String(html || "").matchAll(/<span([^>]*)class="rcmContactAddress"([^>]*)>([\s\S]*?)<\/span>/g)) {
        const title = /title="([^"]*)"/.exec(match[1] + match[2]);
        const text = decodeEntities(match[3].replace(/<[^>]+>/g, "")).trim();
        const address = (title ? decodeEntities(title[1]) : text).trim().toLowerCase();
        out.push({ name: title && text && text.toLowerCase() !== address ? text.slice(0, 200) : null, address: EMAIL.test(address) ? address : null });
        if (out.length >= 20) break;
      }
      return out;
    };
    // Folder listings and searches answer with the same add_message_row calls the UI replays into its list.
    const listing = (json, folder) => {
      const role = (execCalls(json.exec, "set_message_coltypes")[0] || [])[2] === "to" ? "to" : "from";
      const messages = execCalls(json.exec, "add_message_row").map(([uid, cols, flags]) => {
        const who = people(cols && cols.fromto);
        return {
          uid: Number(uid),
          folder: String((flags && flags.mbox) || folder),
          subject: decodeEntities(String((cols && cols.subject) || "").replace(/<[^>]+>/g, "")).slice(0, 500),
          from: role === "from" ? who[0] || null : null,
          to: role === "to" ? who : [],
          date_display: cols && cols.date ? decodeEntities(String(cols.date).replace(/<[^>]+>/g, "")).trim() : null,
          size_display: cols && cols.size ? String(cols.size) : null,
          unread: !(flags && flags.seen),
          flagged: !!(flags && flags.flagged),
          answered: !!(flags && flags.answered),
          content_type: flags && flags.ctype ? String(flags.ctype) : null
        };
      }).filter(message => Number.isInteger(message.uid) && message.uid > 0);
      const env = json.env || {};
      return { messages, total: Number.isInteger(env.messagecount) ? env.messagecount : messages.length, page: Number(env.current_page) || 1, page_count: Number(env.pagecount) || (messages.length ? 1 : 0), search_request: env.search_request || null };
    };
    const listFolderPage = async (folder, page) => listing(await ajax("/?_task=mail&_action=list&_mbox=" + enc(folder) + "&_page=" + page + "&_remote=1&_unlock=0"), folder);
    const searchFolder = async ({ folder, query = "", fields = ["subject"], filter = "ALL", interval = "", page = 1 }) => {
      const first = listing(await ajax("/?_task=mail&_action=search&_q=" + enc(query) + "&_headers=" + enc(fields.join(",")) + "&_mbox=" + enc(folder)
        + "&_scope=base&_filter=" + enc(filter) + (interval ? "&_interval=" + enc(interval) : "") + "&_remote=1&_unlock=0"), folder);
      if (page <= 1 || !first.search_request) return first;
      return listing(await ajax("/?_task=mail&_action=list&_mbox=" + enc(folder) + "&_search=" + enc(first.search_request) + "&_page=" + page + "&_remote=1&_unlock=0"), folder);
    };
    const balancedObject = (text, start) => {
      if (text[start] !== "{") return null;
      let depth = 0, inString = false, escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === "\"") inString = false; continue; }
        if (ch === "\"") inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
      }
      return null;
    };
    // The mail page bootstraps its folder tree through rcmail.set_env({...}); read the same data the UI starts from.
    const mailEnv = async () => {
      const page = await request("/?_task=mail&_mbox=INBOX", { as: "text", remote: false });
      if (page.network_error) stop("site_error", "Loading the mail page failed at the network level.");
      if (page.logged_out) stop("not_authenticated", NOT_SIGNED_IN);
      const html = page.text || "";
      const env = {};
      for (let at = html.indexOf("rcmail.set_env("); at >= 0; at = html.indexOf("rcmail.set_env(", at + 1)) {
        const json = balancedObject(html, at + 15);
        if (json) { try { Object.assign(env, JSON.parse(json)); } catch { /* not a JSON literal */ } }
      }
      if (!env.mailboxes || typeof env.mailboxes !== "object") stop("site_error", "The mail page did not include the folder list; the site may have changed.");
      return env;
    };
    const folderRoles = env => {
      const roles = {};
      for (const [key, role] of [["drafts_mailbox", "drafts"], ["sent_mailbox", "sent"], ["junk_mailbox", "junk"], ["trash_mailbox", "trash"], ["archive_folder", "archive"]]) if (env[key]) roles[env[key]] = role;
      roles.INBOX = "inbox";
      return roles;
    };
    const folderEntries = env => {
      const roles = folderRoles(env);
      return Object.values(env.mailboxes).filter(box => box && typeof box.id === "string" && !box.virtual).slice(0, 200).map(box => ({
        id: box.id,
        name: decodeEntities(String(box.name || box.id)),
        role: roles[box.id] || (["inbox", "drafts", "sent", "junk", "trash", "archive"].includes(box.class) ? box.class : null)
      }));
    };
    try {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "include_counts")
        || (input.include_counts !== undefined && typeof input.include_counts !== "boolean")) stop("invalid_input", "Input may only contain include_counts (boolean).");
      const account = await requireSession();
      const folders = folderEntries(await mailEnv()).map(folder => ({ ...folder, total: null, unread: null }));
      if (input.include_counts !== false) {
        for (const folder of folders) {
          if (remaining() < 5000) break;
          folder.total = (await listFolderPage(folder.id, 100000)).total;
          folder.unread = folder.total === 0 ? 0 : (await searchFolder({ folder: folder.id, filter: "UNSEEN" })).total;
        }
      }
      return { status: "ok", account, folders };
    } catch (error) {
      return failure(error);
    }
  }
}]
