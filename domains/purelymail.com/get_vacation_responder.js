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
