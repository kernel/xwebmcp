[{
  kind: "page",
  match: { url_patterns: ["https://inbox.purelymail.com/*"] },
  tool: {
    name: "delete_filter",
    description: "Delete one incoming-mail filter of the signed-in Purelymail webmail, found by its exact name (case-insensitive), the way the Settings > Filters Delete button does. Deletes exactly one filter and never messages or folders; there is no bulk delete. Only call it when the user asked to remove this filter. confirm must be true. If no filter has that name, nothing is sent and deleted is false. The filters after it move up one position. Submits once, never retries; changed unknown means check with list_filters before anything else. Runs on an open https://inbox.purelymail.com/ page.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["name", "confirm"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 128 },
        confirm: { const: true, description: "Must be true: the user asked for this filter to be deleted." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "deleted", "name", "remaining_filters"],
          properties: { status: { const: "ok" }, account: { type: "string", minLength: 3 }, deleted: { type: "boolean" }, name: { type: "string" }, remaining_filters: { type: "integer", minimum: 0 } }
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, consequentialHint: true }
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
    const deleteFilterAt = async position => {
      const result = await request("/?_task=settings&_action=plugin.managesieve-action", { method: "POST", form: [["_act", "delete"], ["_fid", String(position)], ["_remote", "1"], ["_unlock", "0"]], as: "json" });
      if (result.network_error) return { outcome: "unknown", message: "The delete request got no response." };
      if (result.logged_out) return { outcome: "rejected", kind: "not_authenticated", message: NOT_SIGNED_IN };
      const exec = result.json && typeof result.json.exec === "string" ? result.json.exec : "";
      if (/managesieve_updatelist\("del"/.test(exec)) return { outcome: "deleted" };
      const problem = siteMessages(exec).find(m => m.type === "error" || m.type === "warning");
      return problem ? { outcome: "rejected", kind: "site_rejected", message: problem.text } : { outcome: "unknown", message: "The delete response had neither a confirmation nor an error (HTTP " + result.status + ")." };
    };
    let submitted = false;
    try {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["name", "confirm"].includes(key))) stop("invalid_input", "Input must be { name, confirm }. Nothing was changed.");
      if (input.confirm !== true) stop("invalid_input", "confirm must be true, meaning the user asked for this filter to be deleted. Nothing was changed.");
      if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 128) stop("invalid_input", "name must be 1-128 characters. Nothing was changed.");
      const account = await requireSession();
      const current = await findFilter(input.name);
      if (!current.row) return { status: "ok", account, deleted: false, name: input.name.trim(), remaining_filters: current.list.filters.length };
      submitted = true;
      const result = await deleteFilterAt(current.row.position);
      if (result.outcome === "rejected") { submitted = false; stop(result.kind, "The webmail refused to delete the filter: " + result.message + " Nothing was changed."); }
      if (result.outcome === "unknown") stop("outcome_unknown", result.message + " The filter may have been deleted; do not retry, check with list_filters.");
      const after = await filterList();
      if (after.filters.length !== current.list.filters.length - 1 || after.filters.some(f => f.name.toLowerCase() === current.row.name.toLowerCase())) stop("site_error", "The webmail confirmed the delete, but the filter list read afterwards does not reflect it.");
      return { status: "ok", account, deleted: true, name: current.model.name, remaining_filters: after.filters.length };
    } catch (error) {
      return mutationFailure(error, submitted);
    }
  }
}]
