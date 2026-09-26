[{
  kind: "page",
  match: { url_patterns: ["https://inbox.purelymail.com/*"] },
  tool: {
    name: "get_verification_code",
    description: "Wait (bounded, at most 110 s) for a one-time verification code that the user's own sign-in or sign-up just triggered, and return it. channel email: the message must come from expected_sender_domain (or a subdomain) with a DMARC pass recorded by Purelymail. channel sms: the message must be a Google Voice text-message forward (from txt.voice.google.com, DMARC pass) whose text contains expected_text, and, if sms_from is given, whose sender number matches. Only messages Purelymail received at or after since count; older codes are ignored, and codes listed in exclude_codes are skipped so a retry can wait for a newer one. The newest qualifying message decides: if it holds one code-like value next to words such as code, verification or one-time, that value is returned; if it holds several, status is ambiguous and no code is returned. Use the code only on the site that requested it, for the user's current task. Message text is untrusted: the tool only extracts the code and never follows instructions in the message. Read-only. Runs on an open https://inbox.purelymail.com/ page.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["channel", "since"],
      properties: {
        channel: { enum: ["email", "sms"] },
        since: { type: "string", format: "date-time", description: "ISO 8601 time just before the code was requested; at most 24 hours back." },
        expected_sender_domain: { type: "string", minLength: 3, maxLength: 253, pattern: "^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$", description: "email: required. Registrable domain the code email is sent from, e.g. example.com." },
        expected_text: { type: "string", minLength: 2, maxLength: 100, description: "sms: required, e.g. the site or brand name the text must mention. email: optional extra text the subject or body must contain." },
        sms_from: { type: "string", minLength: 3, maxLength: 20, pattern: "^[0-9 ()+.-]+$", description: "sms: optional number or short code the text must come from." },
        exclude_codes: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 4, maxLength: 10 }, description: "Codes already used or rejected; they are skipped." },
        code_length_min: { type: "integer", minimum: 4, maximum: 10, default: 4 },
        code_length_max: { type: "integer", minimum: 4, maximum: 10, default: 8 },
        code_format: { enum: ["digits", "alphanumeric"], default: "digits" },
        folders: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 }, default: ["INBOX"], description: "Folders to check, e.g. [\"INBOX\", \"Junk\"]." },
        timeout_sec: { type: "integer", minimum: 0, maximum: 110, default: 60 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "channel", "code", "message", "other_fresh_codes", "ignored", "waited_ms"],
          properties: {
            status: { const: "ok" }, account: { type: "string", minLength: 3 }, channel: { enum: ["email", "sms"] },
            code: { type: "string", minLength: 4, maxLength: 10 },
            message: { type: "object", additionalProperties: false, required: ["folder", "uid", "received_at", "from_address", "sender_authentication"], properties: { folder: { type: "string" }, uid: { type: "integer", minimum: 1 }, received_at: { type: "string" }, from_address: { type: ["string", "null"] }, sender_authentication: { enum: ["dmarc_pass", "own_account_submission"] } } },
            other_fresh_codes: { type: "integer", minimum: 0, description: "Distinct different codes in older qualifying messages since since; non-zero means several codes were requested and only the newest is returned." },
            ignored: { type: "object", additionalProperties: false, required: ["stale", "unverified", "mismatch", "excluded", "no_code"], properties: { stale: { type: "integer", minimum: 0 }, unverified: { type: "integer", minimum: 0 }, mismatch: { type: "integer", minimum: 0 }, excluded: { type: "integer", minimum: 0 }, no_code: { type: "integer", minimum: 0 } } },
            waited_ms: { type: "integer", minimum: 0 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "account", "channel", "message", "candidate_count", "error_message"],
          properties: {
            status: { const: "ambiguous" }, account: { type: "string" }, channel: { enum: ["email", "sms"] },
            message: { type: "object", additionalProperties: false, required: ["folder", "uid", "received_at", "from_address", "sender_authentication"], properties: { folder: { type: "string" }, uid: { type: "integer", minimum: 1 }, received_at: { type: "string" }, from_address: { type: ["string", "null"] }, sender_authentication: { enum: ["dmarc_pass", "own_account_submission"] } } },
            candidate_count: { type: "integer", minimum: 2 }, error_message: { type: "string", minLength: 1 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "account", "channel", "ignored", "waited_ms", "error_message"],
          properties: {
            status: { const: "not_found" }, account: { type: "string" }, channel: { enum: ["email", "sms"] },
            ignored: { type: "object", additionalProperties: false, required: ["stale", "unverified", "mismatch", "excluded", "no_code"], properties: { stale: { type: "integer", minimum: 0 }, unverified: { type: "integer", minimum: 0 }, mismatch: { type: "integer", minimum: 0 }, excluded: { type: "integer", minimum: 0 }, no_code: { type: "integer", minimum: 0 } } },
            waited_ms: { type: "integer", minimum: 0 }, error_message: { type: "string", minLength: 1 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "not_authenticated", "not_found", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, untrustedContentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://inbox.purelymail.com";
    const startedAt = Date.now();
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
    // The newest page of the plain folder list; search results can lag behind messages that arrived seconds ago.
    const newestRows = async folder => {
      const first = await listFolderPage(folder, 1);
      const rows = first.messages;
      if (rows.length > 1 && rows[0].uid < rows[rows.length - 1].uid && first.page_count > 1) return (await listFolderPage(folder, first.page_count)).messages;
      return rows;
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
    const bytesOf = text => { const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255; return bytes; };
    const decodeBytes = (text, charset) => {
      if (!/[\x80-\xff]/.test(text)) return text;
      const label = String(charset || "utf-8").trim().replace(/^"|"$/g, "").toLowerCase();
      for (const candidate of [label === "us-ascii" ? "windows-1252" : label, "utf-8"]) {
        try { return new TextDecoder(candidate).decode(bytesOf(text)); } catch { /* unknown charset label */ }
      }
      return text;
    };
    const quotedPrintable = text => text.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    const base64 = text => {
      const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
      try { return atob(clean.slice(0, clean.length - (clean.length % 4))); } catch { return ""; }
    };
    const headerText = value => decodeBytes(String(value || ""), "utf-8")
      .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
      .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g, (match, charset, encoding, data) =>
        decodeBytes(encoding.toUpperCase() === "B" ? base64(data) : quotedPrintable(data.replace(/_/g, " ")), charset));
    const entity = raw => {
      const gap = /\r?\n\r?\n/.exec(raw);
      const head = gap ? raw.slice(0, gap.index) : raw;
      const headers = [];
      for (const line of head.split(/\r?\n(?![ \t])/)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).replace(/\r?\n[ \t]+/g, " ").trim()]);
      }
      return { headers, body: gap ? raw.slice(gap.index + gap[0].length) : "" };
    };
    const header = (headers, name) => { const found = headers.find(h => h[0] === name); return found ? found[1] : null; };
    const headerParam = (value, name) => {
      const text = String(value || "");
      const extended = new RegExp("(?:^|;)\\s*" + name + "\\*(?:0\\*?)?=\\s*([^;]+)", "i").exec(text);
      if (extended) {
        const raw = extended[1].trim().replace(/^"|"$/g, "");
        const parts = /^([^']*)'[^']*'(.*)$/.exec(raw);
        if (!parts) return raw;
        try { return decodeBytes(unescape(parts[2]), parts[1] || "utf-8"); } catch { return parts[2]; }
      }
      const plain = new RegExp("(?:^|;)\\s*" + name + "=\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([^;\\s]+))", "i").exec(text);
      return plain ? (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : plain[2]) : null;
    };
    const walkParts = (raw, depth, found) => {
      const { headers, body } = entity(raw);
      const contentType = header(headers, "content-type") || "text/plain";
      const type = contentType.split(";")[0].trim().toLowerCase();
      const disposition = header(headers, "content-disposition") || "";
      if (type.startsWith("multipart/") && depth < 6) {
        const boundary = headerParam(contentType, "boundary");
        if (!boundary) return;
        const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const closing = new RegExp("(?:^|\\r?\\n)--" + escaped + "--").exec(body);
        const inner = closing ? body.slice(0, closing.index) : body;
        for (const part of inner.split(new RegExp("(?:^|\\r?\\n)--" + escaped + "[ \\t]*\\r?\\n")).slice(1, 80)) walkParts(part, depth + 1, found);
        return;
      }
      const transfer = (header(headers, "content-transfer-encoding") || "").trim().toLowerCase();
      const decoded = transfer === "base64" ? base64(body) : transfer === "quoted-printable" ? quotedPrintable(body) : body;
      const filename = headerParam(disposition, "filename") || headerParam(contentType, "name");
      if (/^attachment/i.test(disposition) || filename || (type !== "text/plain" && type !== "text/html")) {
        if (found.attachments.length < 50) found.attachments.push({ filename: filename ? headerText(filename).slice(0, 200) : null, content_type: type.slice(0, 100), size_bytes_approx: decoded.length });
        return;
      }
      const text = decodeBytes(decoded, headerParam(contentType, "charset"));
      if (type === "text/plain" && found.plain === null) found.plain = text;
      if (type === "text/html" && found.html === null) found.html = text;
    };
    const htmlToText = (html, links) => {
      let text = String(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<(head|style|script|title|template)\b[\s\S]*?<\/\1\s*>/gi, "");
      text = text.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (match, h1, h2, h3, inner) => {
        const href = decodeEntities(h1 ?? h2 ?? h3 ?? "").trim();
        const label = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
        if (/^https?:\/\//i.test(href) && links.length < 20 && !links.some(link => link.url === href)) links.push({ text: label.slice(0, 120), url: href.slice(0, 500) });
        return label;
      });
      text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|section)\s*>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "- ").replace(/<(td|th)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, "");
      return decodeEntities(text);
    };
    const tidy = text => String(text).replace(/\r\n?/g, "\n").replace(/[ \t\u00a0\u200b\u200c\u200d\ufeff]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const addressList = value => {
      const text = headerText(value || "");
      const parts = [];
      let current = "", quoted = false, angle = 0;
      for (const ch of text) {
        if (ch === "\"") quoted = !quoted;
        else if (!quoted && ch === "<") angle++;
        else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
        if (ch === "," && !quoted && !angle) { parts.push(current); current = ""; } else current += ch;
      }
      parts.push(current);
      const out = [];
      for (const part of parts) {
        const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(part);
        const address = (match ? match[2] : part).trim().toLowerCase();
        if (!address) continue;
        out.push({ name: match && match[1] ? match[1].trim().slice(0, 200) : null, address: EMAIL.test(address) ? address : null });
        if (out.length >= 20) break;
      }
      return out;
    };
    const isoDate = value => { const time = Date.parse(String(value || "").replace(/\s*\([^)]*\)\s*$/, "").trim()); return Number.isFinite(time) ? new Date(time).toISOString() : null; };
    // Only the Authentication-Results header Purelymail prepends (above its own first Received header) is trusted; copies inside the message are ignored.
    const senderAuthentication = (headers, from, account) => {
      const firstReceived = headers.findIndex(h => h[0] === "received");
      const results = headers.find((h, i) => h[0] === "authentication-results" && (firstReceived < 0 || i < firstReceived) && /^purelymail\.com\s*;/i.test(h[1]));
      if (!results || !from) return "unverified";
      const dmarc = /\bdmarc=pass\b[^;]*?\bheader\.from=(?:[^@;\s]*@)?([^;\s]+)/i.exec(results[1]);
      if (dmarc && dmarc[1].toLowerCase() === from.split("@")[1]) return "dmarc_pass";
      if (/(?:^|;)\s*auth=pass\b/i.test(results[1]) && from === account) return "own_account_submission";
      return "unverified";
    };
    const parseMessage = (raw, account, maxChars) => {
      const { headers } = entity(raw);
      const from = addressList(header(headers, "from"))[0] || null;
      const received = header(headers, "received");
      const found = { plain: null, html: null, attachments: [] };
      walkParts(raw, 0, found);
      const links = [];
      let source = "none", text = "";
      if (found.plain !== null && found.plain.trim()) { source = "text/plain"; text = found.plain; }
      else if (found.html !== null) { source = "text/html"; text = htmlToText(found.html, links); }
      text = tidy(text);
      if (source === "text/plain") for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) { if (links.length >= 20) break; if (!links.some(link => link.url === match[0])) links.push({ text: null, url: match[0].slice(0, 500) }); }
      const receivedAt = received ? isoDate(received.slice(received.lastIndexOf(";") + 1)) : null;
      return {
        message_id: (header(headers, "message-id") || "").slice(0, 300) || null,
        subject: headerText(header(headers, "subject") || "").slice(0, 500),
        from: from ? { name: from.name, address: from.address } : null,
        to: addressList(header(headers, "to")),
        cc: addressList(header(headers, "cc")),
        reply_to: addressList(header(headers, "reply-to"))[0] || null,
        date: isoDate(header(headers, "date")),
        received_at: receivedAt,
        sender_authentication: senderAuthentication(headers, from && from.address, account),
        auto_submitted: !!header(headers, "auto-submitted") && !/^no\b/i.test(header(headers, "auto-submitted")),
        attachments: found.attachments,
        body_source: source,
        body_text: text.slice(0, maxChars),
        body_chars: text.length,
        body_truncated: text.length > maxChars,
        links
      };
    };
    const readRaw = async (folder, uid, maxBytes) => {
      const result = await request("/?_task=mail&_uid=" + uid + "&_mbox=" + enc(folder) + "&_action=viewsource", { as: "bytes", remote: false, maxBytes });
      if (result.network_error) stop("site_error", "Reading the message source failed at the network level.");
      if (result.logged_out) stop("not_authenticated", NOT_SIGNED_IN);
      const firstLine = result.latin1.replace(/^\s+/, "").split(/\r?\n/, 1)[0];
      if (result.status >= 400 || !/^[\x21-\x39\x3b-\x7e]+:/.test(firstLine)) return null;
      return result;
    };
    const STRONG = /\b(?:codes?|verification|verify|one[- ]?time|otp|passcode|pass code|pin)\b/i;
    const ANY = /\b(?:codes?|verification|verify|one[- ]?time|otp|passcode|pass code|pin|security|log ?in|sign[- ]?in|confirm(?:ation)?|2fa|two[- ]factor|authenticat\w*|token)\b/i;
    // Candidates are ranked: in a code-bearing subject, next to a strong keyword, next to any keyword, then the sole candidate of a code message.
    const extractCodes = (subject, body, { min, max, format }) => {
      const pattern = format === "alphanumeric"
        ? /(?<![\w=&?/#$@.-])([A-Za-z0-9]{4,10})(?![\w@/%-])/g
        : /(?<![\w=&?/#$\u20ac\u00a3+.-])(\d{3,4}[ -]\d{3,4}|\d{4,10})(?![\w/%-]|[.,]\d)/g;
      const scan = text => {
        const out = [];
        for (const match of text.matchAll(pattern)) {
          const code = match[1].replace(/[ -]/g, "");
          if (code.length < min || code.length > max) continue;
          if (format === "alphanumeric" && !(/\d/.test(code) && /[A-Za-z]/.test(code))) continue;
          const before = text.slice(Math.max(0, match.index - 80), match.index);
          const after = text.slice(match.index + match[0].length, match.index + match[0].length + 40).split(/\n/)[0];
          if (/\)\s?$/.test(before) && /[ -]/.test(match[1])) continue;
          if (/^(19|20)\d\d$/.test(code) && /(?:\u00a9|\(c\)|copyright)[^\n]{0,20}$/i.test(before)) continue;
          const lines = before.split("\n");
          const sameLine = lines.pop();
          const lineAbove = sameLine.trim() ? "" : (lines.reverse().find(line => line.trim()) || "");
          out.push({ code, strong: STRONG.test(sameLine.slice(-60)) || STRONG.test(lineAbove) || STRONG.test(after.slice(0, 30)), any: ANY.test(sameLine) || ANY.test(lineAbove) || ANY.test(after) });
        }
        return out;
      };
      const distinct = list => [...new Set(list.map(c => c.code))];
      const inSubject = subject && ANY.test(subject) ? distinct(scan(subject)) : [];
      if (inSubject.length) return inSubject;
      const found = scan(body);
      for (const tier of [found.filter(c => c.strong), found.filter(c => c.any)]) if (tier.length) return distinct(tier);
      return format === "digits" && ANY.test((subject || "") + "\n" + body) ? distinct(found.filter(c => !/^(19|20)\d\d$/.test(c.code))) : [];
    };
    const smsText = text => {
      const withoutLink = text.replace(/^\s*<?https:\/\/voice\.google\.com\/?>?\s*\n?/i, "");
      return withoutLink.split(/\n\s*To respond to this text message/i)[0].trim();
    };
    try {
      const allowed = ["channel", "since", "expected_sender_domain", "expected_text", "sms_from", "exclude_codes", "code_length_min", "code_length_max", "code_format", "folders", "timeout_sec"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) stop("invalid_input", "Unknown input field; allowed: " + allowed.join(", ") + ".");
      const { channel } = input;
      if (channel !== "email" && channel !== "sms") stop("invalid_input", "channel must be email or sms.");
      const since = Date.parse(input.since);
      if (typeof input.since !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(input.since) || !Number.isFinite(since)) stop("invalid_input", "since must be an ISO 8601 date-time with a time zone.");
      if (since < startedAt - 86400000 || since > startedAt + 300000) stop("invalid_input", "since must be within the last 24 hours and not in the future.");
      const domain = typeof input.expected_sender_domain === "string" ? input.expected_sender_domain.trim().toLowerCase() : null;
      if (channel === "email" && (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain))) stop("invalid_input", "channel email requires expected_sender_domain, e.g. example.com.");
      if (channel === "sms" && input.expected_sender_domain !== undefined) stop("invalid_input", "expected_sender_domain applies to channel email only; text-message forwards always come from txt.voice.google.com.");
      const expectedText = typeof input.expected_text === "string" ? input.expected_text.trim().toLowerCase() : null;
      if (input.expected_text !== undefined && (!expectedText || expectedText.length < 2 || expectedText.length > 100 || /[\r\n]/.test(input.expected_text))) stop("invalid_input", "expected_text must be 2-100 characters on one line.");
      if (channel === "sms" && !expectedText) stop("invalid_input", "channel sms requires expected_text, such as the site name the text message must mention.");
      const smsDigits = input.sms_from === undefined ? null : String(input.sms_from).replace(/\D/g, "");
      if (input.sms_from !== undefined && (channel !== "sms" || typeof input.sms_from !== "string" || !/^[0-9 ()+.-]+$/.test(input.sms_from) || smsDigits.length < 3 || smsDigits.length > 15)) stop("invalid_input", "sms_from applies to channel sms and must be a phone number or short code.");
      const min = input.code_length_min === undefined ? 4 : input.code_length_min;
      const max = input.code_length_max === undefined ? 8 : input.code_length_max;
      if (![min, max].every(n => Number.isInteger(n) && n >= 4 && n <= 10) || min > max) stop("invalid_input", "code_length_min and code_length_max must be integers from 4 to 10 with min <= max.");
      const format = input.code_format === undefined ? "digits" : input.code_format;
      if (format !== "digits" && format !== "alphanumeric") stop("invalid_input", "code_format must be digits or alphanumeric.");
      const excluded = input.exclude_codes === undefined ? [] : input.exclude_codes;
      if (!Array.isArray(excluded) || excluded.length > 20 || excluded.some(c => typeof c !== "string" || c.length < 4 || c.length > 10)) stop("invalid_input", "exclude_codes must be up to 20 strings of 4-10 characters.");
      const excludedSet = new Set(excluded.map(c => c.replace(/[ -]/g, "").toLowerCase()));
      const folders = input.folders === undefined ? ["INBOX"] : input.folders;
      if (!Array.isArray(folders) || !folders.length || folders.length > 3 || new Set(folders).size !== folders.length || folders.some(f => typeof f !== "string" || !f.trim() || f.length > 200)) stop("invalid_input", "folders must list 1-3 distinct folder ids.");
      const timeout = input.timeout_sec === undefined ? 60 : input.timeout_sec;
      if (!Number.isInteger(timeout) || timeout < 0 || timeout > 110) stop("invalid_input", "timeout_sec must be an integer from 0 to 110.");
      const account = await requireSession();
      const known = folderEntries(await mailEnv()).map(f => f.id);
      const missing = folders.find(f => !known.includes(f));
      if (missing) stop("not_found", "No folder with id \"" + missing + "\"; call list_folders for the valid ids.");
      const senderDomain = channel === "sms" ? "txt.voice.google.com" : domain;
      const deadline = startedAt + Math.min(timeout * 1000, 108000);
      const examined = new Map();
      const ignored = { stale: 0, unverified: 0, mismatch: 0, excluded: 0, no_code: 0 };
      for (;;) {
        for (const folder of folders) {
          const rows = (await newestRows(folder))
            .filter(m => m.from && m.from.address && (m.from.address.endsWith("@" + senderDomain) || m.from.address.endsWith("." + senderDomain)))
            .filter(m => !examined.has(folder + "/" + m.uid)).sort((a, b) => b.uid - a.uid).slice(0, 10);
          for (const row of rows) {
            const raw = await readRaw(folder, row.uid, 262144);
            const parsed = raw ? parseMessage(raw.latin1, account, 20000) : null;
            const at = parsed ? Date.parse(parsed.received_at || "") : NaN;
            const entry = { folder, uid: row.uid, at, parsed, codes: [] };
            examined.set(folder + "/" + row.uid, entry);
            if (!parsed || !Number.isFinite(at) || at < since) { entry.skip = "stale"; ignored.stale++; continue; }
            const fromAddress = parsed.from && parsed.from.address;
            const fromOk = !!fromAddress && (fromAddress.endsWith("@" + senderDomain) || fromAddress.endsWith("." + senderDomain));
            if (!fromOk || parsed.sender_authentication === "unverified" || (channel === "sms" && parsed.sender_authentication !== "dmarc_pass")) { entry.skip = "unverified"; ignored.unverified++; continue; }
            let subject = parsed.subject;
            let text = parsed.body_text;
            if (channel === "sms") {
              subject = null;
              if (!/^new text message from\b/i.test(parsed.subject)) { entry.skip = "mismatch"; ignored.mismatch++; continue; }
              if (smsDigits) {
                const fromDigits = parsed.subject.replace(/\D/g, "");
                const shorter = Math.min(fromDigits.length, smsDigits.length);
                if (!(fromDigits === smsDigits || (shorter >= 5 && (fromDigits.endsWith(smsDigits) || smsDigits.endsWith(fromDigits))))) { entry.skip = "mismatch"; ignored.mismatch++; continue; }
              }
              text = smsText(parsed.body_text);
            }
            if (expectedText && !((subject || "") + "\n" + text).toLowerCase().includes(expectedText)) { entry.skip = "mismatch"; ignored.mismatch++; continue; }
            const codes = extractCodes(subject, text, { min, max, format });
            const usable = codes.filter(c => !excludedSet.has(c.toLowerCase()));
            if (!codes.length) { entry.skip = "no_code"; ignored.no_code++; continue; }
            entry.codes = usable;
            if (!usable.length) { entry.skip = "excluded"; ignored.excluded++; }
          }
        }
        // A newer code message, even one whose code was excluded, supersedes every older one.
        const qualifying = [...examined.values()].filter(e => !e.skip || e.skip === "excluded").sort((a, b) => b.at - a.at || b.uid - a.uid);
        if (qualifying.length && !qualifying[0].skip) {
          const newest = qualifying[0];
          const message = { folder: newest.folder, uid: newest.uid, received_at: new Date(newest.at).toISOString(), from_address: newest.parsed.from.address, sender_authentication: newest.parsed.sender_authentication };
          if (newest.codes.length > 1) return { status: "ambiguous", account, channel, message, candidate_count: newest.codes.length, error_message: "The newest qualifying message contains several code-like values; read it with read_message and confirm with the user which one to use." };
          const others = new Set(qualifying.slice(1).flatMap(e => e.codes).filter(c => c !== newest.codes[0]));
          return { status: "ok", account, channel, code: newest.codes[0], message, other_fresh_codes: others.size, ignored, waited_ms: Date.now() - startedAt };
        }
        if (Date.now() + 5000 > deadline) break;
        await sleep(5000);
      }
      return { status: "not_found", account, channel, ignored, waited_ms: Date.now() - startedAt, error_message: "No qualifying code message received at or after since arrived before the timeout." };
    } catch (error) {
      return failure(error);
    }
  }
}]
