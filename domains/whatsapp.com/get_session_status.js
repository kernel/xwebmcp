[{
  kind: "page",
  match: { url_patterns: ["https://web.whatsapp.com/*"] },
  tool: {
    name: "get_session_status",
    description: "Report what WhatsApp Web (https://web.whatsapp.com/) is showing in this tab: logged_in when a linked account's chat list is loaded, logged_out when the QR / device-linking screen is shown, or unknown when neither is recognised (for example while the app is still starting). Read-only: it only inspects the current document and never clicks, types, opens a chat, reads the QR code or links a device; linking needs the account owner to scan the QR code with their phone. logged_in does not say which account is linked and does not prove the phone is online. With wait_sec above 0 it keeps checking for up to that many seconds while the state is unknown. Use it before list_chats or search_chats.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        wait_sec: { type: "integer", minimum: 0, maximum: 20, default: 0, description: "Seconds to keep checking while the state is unknown." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "state", "detail"],
          properties: {
            status: { const: "ok" },
            state: { enum: ["logged_in", "logged_out", "unknown"] },
            detail: { type: "string", minLength: 1, description: "What was recognised on the page." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://web.whatsapp.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const args = input === undefined || input === null ? {} : input;
    if (typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "wait_sec")) return fail("invalid_input", "Only wait_sec is accepted.");
    const waitSec = args.wait_sec === undefined ? 0 : args.wait_sec;
    if (!Number.isInteger(waitSec) || waitSec < 0 || waitSec > 20) return fail("invalid_input", "wait_sec must be an integer from 0 to 20.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open https://web.whatsapp.com/ in this tab, then call again.");

    const read = () => {
      if (document.querySelector('[data-testid="wa-web-main-screen"]') && document.querySelector('[data-testid="chat-list-search-container"]')) {
        return { state: "logged_in", detail: "The chat list and its search box are loaded." };
      }
      if (document.querySelector('[data-testid^="link_device_"]')) {
        return { state: "logged_out", detail: "WhatsApp Web is showing its QR / device-linking screen." };
      }
      return { state: "unknown", detail: "Neither the chat list nor the device-linking screen is present; the app may still be loading." };
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const deadline = Date.now() + waitSec * 1000;
    let seen = read();
    while (seen.state === "unknown" && Date.now() < deadline && !(context && context.signal && context.signal.aborted)) {
      await sleep(250);
      seen = read();
    }
    return { status: "ok", state: seen.state, detail: seen.detail };
  }
}]
