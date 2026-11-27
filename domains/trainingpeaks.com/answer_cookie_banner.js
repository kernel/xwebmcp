[{
  kind: "page",
  match: { url_patterns: ["https://trainingpeaks.com/*", "https://*.trainingpeaks.com/*"] },
  tool: {
    name: "answer_cookie_banner",
    title: "Answer the cookie-consent banner",
    description: "Answer TrainingPeaks' cookie-consent banner (\"We value your privacy\") by pressing its own Reject All or Accept Cookies button once, then confirm the banner closed and report the consent groups the site recorded. This is the user's privacy choice: pass the choice the user made, never pick one for them. While the banner is open its overlay covers the page and can block clicks, so get_page_context reports it as consent_banner_visible. If no banner is showing it does nothing and returns no_banner. It does not open or change Cookie Settings; if that panel is open it refuses with settings_open. The choice is stored in the browser's cookies, so it lasts only as long as this browser profile keeps them.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["choice"],
      properties: {
        choice: { enum: ["reject_all", "accept_all"], description: "reject_all presses Reject All (only strictly necessary cookies); accept_all presses Accept Cookies." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "choice", "banner_visible", "consent_groups"],
          properties: {
            status: { enum: ["answered", "no_banner"] },
            choice: { type: ["string", "null"], enum: ["reject_all", "accept_all", null], description: "The button pressed, or null when nothing was pressed." },
            banner_visible: { const: false },
            consent_groups: {
              type: ["object", "null"], additionalProperties: { type: "boolean" },
              description: "Cookie categories the site now records as allowed (OneTrust group ids such as C0001 strictly necessary), or null when the site has not recorded them."
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "pressed"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "settings_open", "button_missing", "not_confirmed"] },
            error_message: { type: "string", minLength: 1 },
            pressed: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async input => {
    let pressed = false;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message, pressed });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be { choice: \"reject_all\" | \"accept_all\" }.");
    const extra = Object.keys(input).filter(k => k !== "choice");
    if (extra.length) return fail("invalid_input", "Unknown input " + extra.join(", ") + ".");
    if (!["reject_all", "accept_all"].includes(input.choice)) return fail("invalid_input", "choice must be reject_all or accept_all, as the user decided.");
    if (!/(^|\.)trainingpeaks\.com$/.test(location.hostname)) return fail("wrong_page", "Open a trainingpeaks.com page first.");
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const groups = () => {
      const raw = (document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("OptanonConsent=")) || "").slice("OptanonConsent=".length);
      const match = /(?:^|&)groups=([^&]*)/.exec(raw);
      if (!match) return null;
      const out = {};
      for (const pair of decodeURIComponent(match[1]).split(",")) {
        const [id, on] = pair.split(":");
        if (/^[A-Za-z0-9_]+$/.test(id || "")) out[id] = on === "1";
      }
      return out;
    };
    const banner = () => visible(document.getElementById("onetrust-banner-sdk"));
    if (visible(document.getElementById("onetrust-pc-sdk"))) return fail("settings_open", "The Cookie Settings panel is open; ask the user to finish or close it there.");
    if (!banner()) return { status: "no_banner", choice: null, banner_visible: false, consent_groups: groups() };
    const button = document.getElementById(input.choice === "reject_all" ? "onetrust-reject-all-handler" : "onetrust-accept-btn-handler");
    if (!visible(button)) return fail("button_missing", "The banner has no visible " + (input.choice === "reject_all" ? "Reject All" : "Accept Cookies") + " button; nothing was pressed.");
    pressed = true;
    button.click();
    const until = Date.now() + 5000;
    while (Date.now() < until && (banner() || !/(^|;\s*)OptanonAlertBoxClosed=/.test(document.cookie))) await new Promise(resolve => setTimeout(resolve, 200));
    if (banner()) return fail("not_confirmed", "The button was pressed but the banner is still showing; check the page before pressing again.");
    return { status: "answered", choice: input.choice, banner_visible: false, consent_groups: groups() };
  }
}]
