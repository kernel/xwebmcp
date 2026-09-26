[{
  kind: "page",
  match: { url_patterns: ["https://inbox.purelymail.com/*"] },
  tool: {
    name: "create_folder",
    description: "Create one mail folder in the signed-in Purelymail webmail through Settings > Folders, at the top level or inside parent (a folder id from list_folders), for example a folder a filter will move messages into. Idempotent: if the folder already exists nothing is sent and created is false. Never renames, moves or deletes folders or messages. confirm must be true. Submits once, never retries; changed unknown means check with list_folders first. Runs on an open https://inbox.purelymail.com/ page.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["name", "confirm"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100, description: "Folder name, without the hierarchy separator." },
        parent: { type: "string", minLength: 1, maxLength: 200, description: "Existing parent folder id; omit for a top-level folder." },
        confirm: { const: true, description: "Must be true: the user asked for this folder." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "created", "folder"],
          properties: {
            status: { const: "ok" }, account: { type: "string", minLength: 3 }, created: { type: "boolean" },
            folder: { type: "object", additionalProperties: false, required: ["id", "name"], properties: { id: { type: "string", minLength: 1 }, name: { type: "string" } } }
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
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
    let submitted = false;
    try {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["name", "parent", "confirm"].includes(key))) stop("invalid_input", "Input must be { name, parent?, confirm }. Nothing was changed.");
      if (input.confirm !== true) stop("invalid_input", "confirm must be true, meaning the user asked for this folder. Nothing was changed.");
      const account = await requireSession();
      const env = await mailEnv();
      const delimiter = typeof env.delimiter === "string" && env.delimiter ? env.delimiter : ".";
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 100 || name.includes(delimiter) || /[\u0000-\u001f\u007f*%\\/]/.test(name) || /^inbox$/i.test(name)) stop("invalid_input", "name must be 1-100 characters without \"" + delimiter + "\", slashes, * or %, and not INBOX. Nothing was changed.");
      const folders = folderEntries(env);
      if (input.parent !== undefined && (typeof input.parent !== "string" || !folders.some(f => f.id === input.parent))) stop("not_found", "parent must be an existing folder id from list_folders. Nothing was changed.");
      const id = input.parent === undefined ? name : input.parent + delimiter + name;
      const existing = folders.find(f => f.id.toLowerCase() === id.toLowerCase());
      if (existing) return { status: "ok", account, created: false, folder: { id: existing.id, name: existing.name } };
      submitted = true;
      const result = await request("/", { method: "POST", form: [["_token", token()], ["_framed", "1"], ["_task", "settings"], ["_action", "save-folder"], ["_name", name], ["_parent", input.parent || ""]], as: "text", remote: false });
      if (result.network_error) stop("outcome_unknown", "The create request got no response; the folder may exist now. Check with list_folders.");
      if (result.logged_out) { submitted = false; stop("not_authenticated", NOT_SIGNED_IN); }
      const html = result.text || "";
      if (!/add_folder_row\(/.test(html)) {
        const problem = siteMessages(html).find(m => m.type === "error" || m.type === "warning");
        if (problem) { submitted = false; stop("site_rejected", "The webmail refused to create the folder: " + problem.text + " Nothing was changed."); }
        stop("outcome_unknown", "The create response had neither a confirmation nor an error; the folder may exist now. Check with list_folders.");
      }
      const created = folderEntries(await mailEnv()).find(f => f.id === id);
      if (!created) stop("site_error", "The webmail confirmed the folder, but it is not in the folder list read afterwards.");
      return { status: "ok", account, created: true, folder: { id: created.id, name: created.name } };
    } catch (error) {
      return mutationFailure(error, submitted);
    }
  }
}]
