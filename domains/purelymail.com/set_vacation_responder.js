[{
  kind: "page",
  match: { url_patterns: ["https://inbox.purelymail.com/*"] },
  tool: {
    name: "set_vacation_responder",
    description: "Turn the vacation (out-of-office) auto-reply of the signed-in Purelymail webmail on or off, or change its message, subject or repeat interval. Purelymail's webmail stores it as a filter with a vacation reply action; this tool edits that filter through Settings > Filters. With no responder yet it creates one named filter_name (default \"Vacation responder\") that applies to every incoming message; message is then required, and enabled false creates it switched off. With exactly one responder it edits that one in place, keeping its conditions and other actions; with several, pass filter_name to choose. Fields not given keep their current values. While enabled, Purelymail automatically replies to people who write to this mailbox (at most once per sender per days), so only enable it when the user asked. confirm must be true. If nothing would change, nothing is sent and changed is false. Submits once, never retries; changed unknown means check with get_vacation_responder first. Runs on an open https://inbox.purelymail.com/ page.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["enabled", "confirm"],
      properties: {
        enabled: { type: "boolean", description: "true sends automatic replies; false keeps the responder but stops replies." },
        message: { type: "string", minLength: 1, maxLength: 4000, description: "Plain-text reply body." },
        subject: { type: "string", minLength: 1, maxLength: 200, description: "Reply subject; when never set the server uses an automatic subject." },
        days: { type: "integer", minimum: 1, maximum: 30, description: "Minimum days between replies to the same sender." },
        filter_name: { type: "string", minLength: 1, maxLength: 128, description: "Responder filter to edit or create." },
        confirm: { const: true, description: "Must be true: the user asked for this change." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "changed", "created", "filter_set_active", "responder"],
          properties: {
            status: { const: "ok" }, account: { type: "string", minLength: 3 }, changed: { type: "boolean" }, created: { type: "boolean" },
            filter_set_active: { type: ["boolean", "null"] },
            responder: { oneOf: [{ type: "null" }, {
              type: "object", additionalProperties: false, required: ["filter_name", "position", "enabled", "applies_to", "message", "subject", "days", "from", "addresses", "other_actions"],
              properties: {
                filter_name: { type: "string" }, position: { type: "integer", minimum: 0 }, enabled: { type: "boolean" },
                applies_to: { enum: ["every_message", "conditional"], description: "conditional: the reply only goes to messages matching the filter's conditions." },
                message: { type: "string" }, subject: { type: ["string", "null"] },
                days: { type: ["integer", "null"], description: "Minimum days between replies to the same sender; null uses the server default (usually 7)." },
                from: { type: ["string", "null"] }, addresses: { type: "array", items: { type: "string" } },
                other_actions: { type: "array", items: { type: "string" } }
              }
            }] }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "changed"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "not_authenticated", "not_found", "already_exists", "ambiguous", "conflict", "unsupported_filter", "site_rejected", "outcome_unknown", "site_error"] },
            error_message: { type: "string", minLength: 1 },
            changed: { enum: [false, "unknown"], description: "unknown: a change was submitted and may have been applied; do not retry, re-read the state first." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true, consequentialHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://inbox.purelymail.com";
    const stop = (kind, message) => { const error = new Error(message); error.kind = kind; throw error; };
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
    // Reads the fields of server-rendered form markup the way the browser would submit them.
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
    let submitted = false;
    try {
      const allowed = ["enabled", "message", "subject", "days", "filter_name", "confirm"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) stop("invalid_input", "Unknown input field; allowed: " + allowed.join(", ") + ". Nothing was changed.");
      if (input.confirm !== true) stop("invalid_input", "confirm must be true, meaning the user asked for this change. Nothing was changed.");
      if (typeof input.enabled !== "boolean") stop("invalid_input", "enabled must be a boolean. Nothing was changed.");
      if (input.message !== undefined && (typeof input.message !== "string" || !input.message.trim() || input.message.length > 4000 || /\u0000/.test(input.message))) stop("invalid_input", "message must be 1-4000 characters. Nothing was changed.");
      if (input.subject !== undefined && (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 200 || /[\r\n\u0000]/.test(input.subject))) stop("invalid_input", "subject must be 1-200 characters on one line. Nothing was changed.");
      if (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > 30)) stop("invalid_input", "days must be an integer from 1 to 30. Nothing was changed.");
      if (input.filter_name !== undefined && (typeof input.filter_name !== "string" || !input.filter_name.trim() || input.filter_name.length > 128 || /[\r\n\u0000]/.test(input.filter_name))) stop("invalid_input", "filter_name must be 1-128 characters on one line. Nothing was changed.");
      const account = await requireSession();
      const { list, found } = await responders();
      const wanted = input.filter_name ? input.filter_name.trim() : null;
      let target = null;
      if (wanted) {
        target = found.find(f => f.model.name.trim().toLowerCase() === wanted.toLowerCase()) || null;
        if (!target && list.filters.some(f => f.name.toLowerCase() === wanted.toLowerCase())) stop("conflict", "A filter named \"" + wanted + "\" exists but has no vacation reply; choose another filter_name. Nothing was changed.");
      } else if (found.length > 1) stop("ambiguous", "There are " + found.length + " vacation responders (" + found.map(f => "\"" + f.model.name + "\"").join(", ") + "); pass filter_name to choose one. Nothing was changed.");
      else target = found[0] || null;
      const message = input.message === undefined ? null : input.message.replace(/\r\n?/g, "\n").trim();
      let model;
      if (target) {
        const vacations = target.model.actions.filter(a => a.type === "vacation");
        if (vacations.length !== 1 || !target.model.conditions.every(c => c.editable) || !target.model.actions.every(a => a.type === "vacation" || a.editable)) stop("unsupported_filter", "The responder filter \"" + target.model.name + "\" uses parts these tools cannot rewrite faithfully; edit it in the webmail. Nothing was changed.");
        model = {
          name: target.model.name, enabled: input.enabled, match: target.model.match, conditions: target.model.conditions,
          actions: target.model.actions.map(a => a.type !== "vacation" ? a : { ...a, message: message === null ? a.message : message, subject: input.subject === undefined ? a.subject : input.subject.trim(), days: input.days === undefined ? a.days : input.days })
        };
        if (!model.actions.find(a => a.type === "vacation").message.trim()) stop("invalid_input", "The responder has no message; pass message. Nothing was changed.");
        if (sameFilter(target.model, model)) return { status: "ok", account, changed: false, created: false, filter_set_active: list.filter_set_active, responder: responderOf(target.model, target.row.position) };
      } else {
        if (message === null) {
          if (!input.enabled) return { status: "ok", account, changed: false, created: false, filter_set_active: list.filter_set_active, responder: null };
          stop("invalid_input", "No vacation responder exists yet; pass message to create one. Nothing was changed.");
        }
        const name = wanted || "Vacation responder";
        if (list.filters.some(f => f.name.toLowerCase() === name.toLowerCase())) stop("conflict", "A filter named \"" + name + "\" already exists without a vacation reply; pass another filter_name. Nothing was changed.");
        model = { name, enabled: input.enabled, match: "every_message", conditions: [], actions: [{ type: "vacation", message, subject: input.subject === undefined ? null : input.subject.trim(), from: null, addresses: [], days: input.days === undefined ? null : input.days }] };
      }
      submitted = true;
      const saved = await saveFilter(model, target ? target.row.position : null);
      if (saved.outcome === "rejected") { submitted = false; stop(saved.kind, "The webmail rejected the responder: " + saved.message + " Nothing was changed."); }
      if (saved.outcome === "unknown") stop("outcome_unknown", saved.message + " The responder may have been changed; do not retry, check with get_vacation_responder.");
      const after = await findFilter(model.name);
      if (!after.row || !sameFilter(after.model, model)) stop("site_error", "The webmail confirmed the save, but reading the responder back did not match the request.");
      return { status: "ok", account, changed: true, created: !target, filter_set_active: after.list.filter_set_active, responder: responderOf(after.model, after.row.position) };
    } catch (error) {
      return mutationFailure(error, submitted);
    }
  }
}]
