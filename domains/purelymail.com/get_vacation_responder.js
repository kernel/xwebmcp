[{
  kind: "page",
  match: { url_patterns: ["https://inbox.purelymail.com/*"] },
  tool: {
    name: "get_vacation_responder",
    description: "Read the vacation (out-of-office) auto-reply of the signed-in Purelymail webmail. Purelymail's webmail keeps it as a filter with a vacation reply action (Settings > Filters); this lists every such filter with its reply message, subject, the days between repeat replies to the same sender, whether it is enabled, and whether it applies to every message or only to messages matching conditions. active is true when an enabled responder exists and the filter set is switched on, meaning senders currently get automatic replies. Read-only. Runs on an open https://inbox.purelymail.com/ page.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "active", "filter_set_active", "responders"],
          properties: { status: { const: "ok" }, account: { type: "string", minLength: 3 }, active: { type: "boolean" }, filter_set_active: { type: ["boolean", "null"] }, responders: { type: "array", items: {
            type: "object", additionalProperties: false, required: ["filter_name", "position", "enabled", "applies_to", "message", "subject", "days", "from", "addresses", "other_actions"],
            properties: {
              filter_name: { type: "string" }, position: { type: "integer", minimum: 0 }, enabled: { type: "boolean" },
              applies_to: { enum: ["every_message", "conditional"], description: "conditional: the reply only goes to messages matching the filter's conditions." },
              message: { type: "string" }, subject: { type: ["string", "null"] },
              days: { type: ["integer", "null"], description: "Minimum days between replies to the same sender; null uses the server default (usually 7)." },
              from: { type: ["string", "null"] }, addresses: { type: "array", items: { type: "string" } },
              other_actions: { type: "array", items: { type: "string" } }
            }
          } } }
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
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    const siteMessages = source => [...String(source || "").matchAll(/display_message\("((?:[^"\\]|\\.)*)","(error|warning|confirmation|notice)"/g)]
      .map(match => { try { return { text: JSON.parse("\"" + match[1] + "\""), type: match[2] }; } catch { return { text: match[1], type: match[2] }; } });
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
    // After a submission only a site-confirmed rejection proves nothing changed.
    const mutationFailure = (error, submitted) => {
      const out = failure(error);
      out.changed = submitted ? "unknown" : false;
      if (submitted && out.error_kind !== "outcome_unknown") {
        out.error_kind = "outcome_unknown";
        out.error_message += " A change had already been submitted and may have been applied; do not retry, re-read the current state first.";
      }
      return out;
    };
    const tagAttributes = tag => {
      const out = {};
      const inner = tag.replace(/^<\w+/, "").replace(/\/?>$/, "");
      for (const match of inner.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
      return out;
    };
    // The filter editor is a server-rendered form; read it the way the browser would submit it.
    const formFields = html => {
      const fields = [];
      for (const match of String(html).matchAll(/<input\b[^>]*>|<textarea\b[^>]*>[\s\S]*?<\/textarea>|<select\b[^>]*>[\s\S]*?<\/select>/gi)) {
        const markup = match[0];
        const tag = /^<(\w+)/.exec(markup)[1].toLowerCase();
        const attributes = tagAttributes(/^<[^>]*>/.exec(markup)[0]);
        if (!attributes.name) continue;
        if (tag === "input") fields.push({ tag, name: attributes.name, type: (attributes.type || "text").toLowerCase(), value: decodeEntities(attributes.value || ""), checked: "checked" in attributes });
        else if (tag === "textarea") fields.push({ tag, name: attributes.name, value: decodeEntities(markup.replace(/^<[^>]*>\r?\n?/, "").replace(/<\/textarea>$/i, "")) });
        else {
          const options = [...markup.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map(option => {
            const optionAttributes = tagAttributes("<option" + option[1] + ">");
            return { value: decodeEntities(optionAttributes.value ?? option[2]), selected: "selected" in optionAttributes };
          });
          const selected = options.find(option => option.selected) || options[0];
          fields.push({ tag, name: attributes.name, value: selected ? selected.value : "", options: options.map(option => option.value) });
        }
      }
      return fields;
    };
    const SITE_OPERATORS = { contains: "contains", notcontains: "not_contains", is: "is", notis: "not_is", matches: "matches", notmatches: "not_matches", exists: "exists", notexists: "not_exists" };
    const TOOL_OPERATORS = Object.fromEntries(Object.entries(SITE_OPERATORS).map(([site, tool]) => [tool, site]));
    const FLAG_NAMES = { "\\Seen": "seen", "\\Answered": "answered", "\\Flagged": "flagged", "\\Deleted": "deleted", "\\Draft": "draft" };
    const SITE_FLAGS = { seen: "\\Seen", answered: "\\Answered", flagged: "\\Flagged" };
    const FLAG_ACTIONS = { addflag: "add_flags", setflag: "set_flags", removeflag: "remove_flags" };
    const parseFilterForm = html => {
      const fields = formFields(html);
      const value = name => { const field = fields.find(f => f.name === name); return field ? field.value : null; };
      const lines = name => String(value(name) || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const indexes = prefix => [...new Set(fields.map(f => f.name.startsWith(prefix + "[") ? /^\[(\d+)\]$/.exec(f.name.slice(prefix.length)) : null).filter(Boolean).map(m => Number(m[1])))].sort((a, b) => a - b);
      if (value("_name") === null || value("_join") === null) return null;
      const join = value("_join");
      const conditions = join === "any" ? [] : indexes("_header").map(i => {
        const site = value("_header[" + i + "]");
        const custom = lines("_custom_header[" + i + "]");
        const operator = value("_rule_op[" + i + "]");
        const plainField = ["subject", "from", "to", "body"].includes(site);
        const supported = (plainField || (site === "..." && custom.length === 1)) && Object.hasOwn(SITE_OPERATORS, operator)
          && !value("_rule_mod[" + i + "]") && !value("_rule_comp[" + i + "]") && (site !== "body" || (value("_rule_trans[" + i + "]") || "text") === "text");
        return {
          field: plainField ? site : site === "..." ? "header" : "unsupported",
          header_name: site === "..." ? custom[0] || null : null,
          operator: SITE_OPERATORS[operator] || String(operator),
          values: /exists$/.test(operator) ? [] : lines("_rule_target[" + i + "]"),
          editable: supported
        };
      });
      const actions = indexes("_action_type").map(i => {
        const type = value("_action_type[" + i + "]");
        if (type === "fileinto" || type === "fileinto_copy") return { type: type === "fileinto" ? "move_to_folder" : "copy_to_folder", folder: value("_action_mailbox[" + i + "]"), editable: true };
        if (Object.hasOwn(FLAG_ACTIONS, type)) {
          const flags = fields.filter(f => f.name === "_action_flags[" + i + "][]" && f.tag === "input" && f.checked).map(f => FLAG_NAMES[f.value] || f.value);
          const custom = lines("_action_flags[" + i + "]");
          return { type: FLAG_ACTIONS[type], flags: [...flags, ...custom], editable: !custom.length && flags.length > 0 && flags.every(flag => Object.hasOwn(SITE_FLAGS, flag)) };
        }
        if (type === "keep" || type === "stop") return { type, editable: true };
        if (type === "vacation") {
          const days = Number(value("_action_interval[" + i + "]"));
          return {
            type: "vacation", message: String(value("_action_reason[" + i + "]") || "").replace(/\r\n?/g, "\n"), subject: value("_action_subject[" + i + "]") || null,
            from: value("_action_from[" + i + "]") || null, addresses: lines("_action_addresses[" + i + "]"),
            days: value("_action_interval_type[" + i + "]") === "seconds" || !Number.isInteger(days) || days < 1 ? null : days,
            interval_unit: value("_action_interval_type[" + i + "]") === "seconds" ? "seconds" : "days", editable: false
          };
        }
        return { type: "other", site_type: String(type), editable: false };
      });
      return {
        name: value("_name"),
        enabled: fields.some(f => f.name === "_enabled" && f.checked),
        match: join === "any" ? "every_message" : join === "anyof" ? "any" : "all",
        conditions, actions,
        editable: ["allof", "anyof", "any"].includes(join) && conditions.every(c => c.editable) && actions.every(a => a.editable)
      };
    };
    const publicFilter = (model, fid) => ({
      position: fid, name: model.name, enabled: model.enabled, match: model.match,
      conditions: model.conditions.map(c => ({ field: c.field, header_name: c.header_name, operator: c.operator, values: c.values })),
      actions: model.actions.map(a => { const copy = { ...a }; delete copy.editable; return copy; }),
      editable: model.editable
    });
    // Mirrors the field set the filter editor serializes, one block per rule row and per action row.
    const encodeFilter = (model, fid) => {
      const entries = [["_token", token()], ["_task", "settings"], ["_action", "plugin.managesieve-save"], ["_framed", "1"], ["_fid", fid === null ? "" : String(fid)], ["_name", model.name]];
      if (model.enabled) entries.push(["_enabled", "1"]);
      entries.push(["_join", model.match === "every_message" ? "any" : model.match === "any" ? "anyof" : "allof"]);
      const rules = model.match === "every_message" || !model.conditions.length ? [{ field: "subject", header_name: null, operator: "contains", values: [] }] : model.conditions;
      rules.forEach((rule, i) => {
        const at = name => name + "[" + i + "]";
        entries.push([at("_header"), rule.field === "header" ? "..." : rule.field], [at("_custom_header") + "[]", rule.field === "header" ? rule.header_name : ""], [at("_custom_var") + "[]", ""],
          [at("_rule_date_part"), "date"], [at("_rule_op"), TOOL_OPERATORS[rule.operator]]);
        for (const target of rule.values.length ? rule.values : [""]) entries.push([at("_rule_target") + "[]", target]);
        entries.push([at("_rule_size_op"), "over"], [at("_rule_size_target"), ""], [at("_rule_size_item"), ""], [at("_rule_spamtest_op"), ""], [at("_rule_spamtest_target"), "1"],
          [at("_rule_mod"), ""], [at("_rule_mod_type"), "all"], [at("_rule_comp"), ""], [at("_rule_trans"), "text"], [at("_rule_trans_type"), ""], [at("_rule_date_header"), ""]);
      });
      model.actions.forEach((action, i) => {
        const at = name => name + "[" + i + "]";
        const siteType = { move_to_folder: "fileinto", copy_to_folder: "fileinto_copy", add_flags: "addflag", set_flags: "setflag", remove_flags: "removeflag", keep: "keep", stop: "stop", vacation: "vacation" }[action.type];
        const vacation = action.type === "vacation";
        entries.push([at("_action_type"), siteType], [at("_action_target"), ""], [at("_action_target_area"), ""], [at("_action_reason"), vacation ? action.message : ""],
          [at("_action_subject"), vacation && action.subject ? action.subject : ""], [at("_action_from"), vacation && action.from ? action.from : ""]);
        for (const address of vacation && action.addresses.length ? action.addresses : [""]) entries.push([at("_action_addresses") + "[]", address]);
        entries.push([at("_action_interval"), vacation && action.days ? String(action.days) : ""], [at("_action_interval_type"), "days"]);
        for (const flag of action.flags || []) entries.push([at("_action_flags") + "[]", SITE_FLAGS[flag]]);
        entries.push([at("_action_flags") + "[]", ""], [at("_action_varname"), ""], [at("_action_varvalue"), ""], [at("_action_notifymethod"), "mailto"], [at("_action_notifytarget"), ""],
          [at("_action_notifymessage"), ""], [at("_action_notifyimportance"), "2"], [at("_action_notifyoption") + "[]", ""], [at("_action_mailbox"), action.folder || "INBOX"]);
      });
      return entries;
    };
    const filterList = async () => {
      const page = await request("/?_task=settings&_action=plugin.managesieve", { as: "text", remote: false });
      if (page.network_error) stop("site_error", "Loading the filters page failed at the network level.");
      if (page.logged_out) stop("not_authenticated", NOT_SIGNED_IN);
      const html = page.text || "";
      if (page.status >= 400 || !/id="filterslist"/.test(html)) stop("site_error", "The filters page did not contain the filter list; the site may have changed.");
      const rows = [...html.matchAll(/<tr\b([^>]*)\bid="rcmrow(\d+)"([^>]*)>\s*<td class="name">([\s\S]*?)<\/td>/g)]
        .map(m => ({ position: Number(m[2]), name: decodeEntities(m[4].replace(/<[^>]+>/g, "")).trim(), enabled: !/\bdisabled\b/.test(m[1] + m[3]) }));
      const set = /<tr\b([^>]*)\bid="rcmrowS\d+"([^>]*)>\s*<td class="name">([\s\S]*?)<\/td>/.exec(html);
      const current = /"currentset":"((?:[^"\\]|\\.)*)"/.exec(html);
      return {
        filters: rows,
        filter_set: current ? JSON.parse("\"" + current[1] + "\"") : set ? decodeEntities(set[3]).trim() : null,
        filter_set_active: set ? !/\bdisabled\b/.test(set[1] + set[2]) : null
      };
    };
    const readFilter = async position => {
      const page = await request("/?_task=settings&_action=plugin.managesieve-action&_framed=1&_fid=" + position, { as: "text", remote: false });
      if (page.network_error) stop("site_error", "Loading a filter failed at the network level.");
      if (page.logged_out) stop("not_authenticated", NOT_SIGNED_IN);
      const model = page.status < 400 ? parseFilterForm(page.text || "") : null;
      if (!model) stop("site_error", "The filter editor for position " + position + " could not be read.");
      return model;
    };
    const findFilter = async name => {
      const list = await filterList();
      const wanted = name.trim().toLowerCase();
      const matches = list.filters.filter(f => f.name.toLowerCase() === wanted);
      if (matches.length > 1) stop("ambiguous", "More than one filter is named \"" + name + "\"; rename one in the webmail first. Nothing was changed.");
      if (!matches.length) return { list, row: null, model: null };
      const model = await readFilter(matches[0].position);
      if (model.name.trim().toLowerCase() !== wanted) stop("conflict", "The filter list changed while it was being read; nothing was changed. Invoke again.");
      return { list, row: matches[0], model };
    };
    // One POST, never repeated here: an unanswered save may still have been applied.
    const saveFilter = async (model, position) => {
      const result = await request("/", { method: "POST", form: encodeFilter(model, position), as: "text", remote: false });
      if (result.network_error) return { outcome: "unknown", message: "The save request got no response." };
      if (result.logged_out) return { outcome: "rejected", message: NOT_SIGNED_IN, kind: "not_authenticated" };
      const html = result.text || "";
      const saved = /managesieve_updatelist\("(add|update)",(\{[^}]*\})\)/.exec(html);
      if (saved) return { outcome: "saved" };
      const problem = siteMessages(html).find(m => m.type === "error" || m.type === "warning");
      if (problem) return { outcome: "rejected", message: problem.text, kind: "site_rejected" };
      return { outcome: "unknown", message: "The save response had neither a confirmation nor an error (HTTP " + result.status + ")." };
    };
    const normalizedFilter = model => JSON.stringify({
      name: model.name, enabled: !!model.enabled, match: model.match,
      conditions: model.match === "every_message" ? [] : model.conditions.map(c => ({ field: c.field, header_name: c.field === "header" ? String(c.header_name).toLowerCase() : null, operator: c.operator, values: c.values })),
      actions: model.actions.map(a => a.type === "move_to_folder" || a.type === "copy_to_folder" ? { type: a.type, folder: a.folder }
        : /_flags$/.test(a.type) ? { type: a.type, flags: [...a.flags].sort() }
        : a.type === "vacation" ? { type: a.type, message: a.message, subject: a.subject || null, from: a.from || null, addresses: a.addresses || [], days: a.days || null }
        : a.type === "other" ? { type: a.type, site_type: a.site_type } : { type: a.type })
    });
    const sameFilter = (a, b) => normalizedFilter(a) === normalizedFilter(b);
    const FIELDS = ["subject", "from", "to", "body", "header"];
    const ACTION_TYPES = ["move_to_folder", "copy_to_folder", "add_flags", "set_flags", "remove_flags", "keep", "stop"];
    // Validates a filter the caller described; every problem is reported before anything is sent.
    const checkFilterSpec = (spec, folderIds) => {
      const bad = message => stop("invalid_input", message + " Nothing was changed.");
      const only = (object, keys, label) => { if (!object || typeof object !== "object" || Array.isArray(object) || Object.keys(object).some(k => !keys.includes(k))) bad(label + " may only contain " + keys.join(", ") + "."); };
      if (typeof spec.name !== "string" || !spec.name.trim() || spec.name.trim().length > 128 || /[\r\n\u0000]/.test(spec.name)) bad("name must be 1-128 characters on one line.");
      if (typeof spec.enabled !== "boolean") bad("enabled must be a boolean.");
      if (!["all", "any", "every_message"].includes(spec.match)) bad("match must be all, any or every_message.");
      if (!Array.isArray(spec.conditions) || spec.conditions.length > 10) bad("conditions must be an array of at most 10 conditions.");
      if (spec.match !== "every_message" && !spec.conditions.length) bad("At least one condition is required unless match is every_message.");
      if (spec.match === "every_message" && spec.conditions.length) bad("match every_message takes no conditions.");
      const conditions = spec.conditions.map((c, i) => {
        only(c, ["field", "header_name", "operator", "values"], "conditions[" + i + "]");
        if (!FIELDS.includes(c.field)) bad("conditions[" + i + "].field must be one of " + FIELDS.join(", ") + ".");
        if (c.field === "header" ? (typeof c.header_name !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(c.header_name)) : c.header_name !== undefined && c.header_name !== null) bad("conditions[" + i + "].header_name is required for field header (letters, digits, hyphens) and not allowed otherwise.");
        if (!Object.hasOwn(TOOL_OPERATORS, c.operator)) bad("conditions[" + i + "].operator must be one of " + Object.keys(TOOL_OPERATORS).join(", ") + ".");
        const presence = /exists$/.test(c.operator);
        if (presence && c.field === "body") bad("conditions[" + i + "]: exists and not_exists do not apply to body.");
        const values = c.values === undefined ? [] : c.values;
        if (!Array.isArray(values) || (presence ? values.length : !values.length || values.length > 10) || values.some(v => typeof v !== "string" || !v.trim() || v.length > 200 || /[\r\n\u0000]/.test(v))) bad("conditions[" + i + "].values must be 1-10 one-line strings (none for exists and not_exists).");
        return { field: c.field, header_name: c.field === "header" ? c.header_name : null, operator: c.operator, values: values.map(v => v.trim()) };
      });
      if (!Array.isArray(spec.actions) || !spec.actions.length || spec.actions.length > 6) bad("actions must be an array of 1-6 actions.");
      const actions = spec.actions.map((a, i) => {
        if (!a || typeof a !== "object" || !ACTION_TYPES.includes(a.type)) bad("actions[" + i + "].type must be one of " + ACTION_TYPES.join(", ") + ".");
        if (a.type === "move_to_folder" || a.type === "copy_to_folder") {
          only(a, ["type", "folder"], "actions[" + i + "]");
          if (typeof a.folder !== "string" || !folderIds.includes(a.folder)) bad("actions[" + i + "].folder must be an existing folder id from list_folders" + (typeof a.folder === "string" ? " (\"" + a.folder + "\" does not exist; create_folder can add it)" : "") + ".");
          return { type: a.type, folder: a.folder };
        }
        if (/_flags$/.test(a.type)) {
          only(a, ["type", "flags"], "actions[" + i + "]");
          if (!Array.isArray(a.flags) || !a.flags.length || a.flags.some(f => !Object.hasOwn(SITE_FLAGS, f)) || new Set(a.flags).size !== a.flags.length) bad("actions[" + i + "].flags must list distinct values from seen, flagged, answered.");
          return { type: a.type, flags: [...a.flags] };
        }
        only(a, ["type"], "actions[" + i + "]");
        return { type: a.type };
      });
      const move = actions.findIndex(a => a.type === "move_to_folder");
      if (actions.filter(a => a.type === "move_to_folder").length > 1) bad("Only one move_to_folder action is allowed; use copy_to_folder for extra copies.");
      if (move >= 0 && actions.some((a, i) => i > move && /_flags$/.test(a.type))) bad("Flag actions must come before move_to_folder, otherwise the moved message does not get the flags.");
      if (actions.some((a, i) => a.type === "stop" && i !== actions.length - 1)) bad("stop must be the last action.");
      return { name: spec.name.trim(), enabled: spec.enabled, match: spec.match, conditions, actions };
    };
    const deleteFilterAt = async position => {
      const result = await request("/?_task=settings&_action=plugin.managesieve-action", { method: "POST", form: [["_act", "delete"], ["_fid", String(position)], ["_remote", "1"], ["_unlock", "0"]], as: "json" });
      if (result.network_error) return { outcome: "unknown", message: "The delete request got no response." };
      if (result.logged_out) return { outcome: "rejected", kind: "not_authenticated", message: NOT_SIGNED_IN };
      const exec = result.json && typeof result.json.exec === "string" ? result.json.exec : "";
      if (/managesieve_updatelist\("del"/.test(exec)) return { outcome: "deleted" };
      const problem = siteMessages(exec).find(m => m.type === "error" || m.type === "warning");
      return problem ? { outcome: "rejected", kind: "site_rejected", message: problem.text } : { outcome: "unknown", message: "The delete response had neither a confirmation nor an error (HTTP " + result.status + ")." };
    };
    const responderOf = (model, position) => {
      const vacation = model.actions.find(a => a.type === "vacation");
      return {
        filter_name: model.name, position, enabled: model.enabled,
        applies_to: model.match === "every_message" ? "every_message" : "conditional",
        message: vacation.message, subject: vacation.subject, days: vacation.days, from: vacation.from, addresses: vacation.addresses,
        other_actions: model.actions.filter(a => a.type !== "vacation").map(a => a.type === "other" ? a.site_type : a.type)
      };
    };
    const responders = async () => {
      const list = await filterList();
      const found = [];
      for (const row of list.filters.slice(0, 50)) {
        const model = await readFilter(row.position);
        if (model.actions.some(a => a.type === "vacation")) found.push({ row, model });
      }
      return { list, found };
    };
    try {
      if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) stop("invalid_input", "This tool takes no input.");
      const account = await requireSession();
      const { list, found } = await responders();
      const items = found.map(({ row, model }) => responderOf(model, row.position));
      return { status: "ok", account, active: list.filter_set_active !== false && items.some(r => r.enabled), filter_set_active: list.filter_set_active, responders: items };
    } catch (error) {
      return failure(error);
    }
  }
}]
