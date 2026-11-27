[{
  kind: "page",
  match: { url_patterns: ["https://trainingpeaks.com/*", "https://*.trainingpeaks.com/*"] },
  tool: {
    name: "navigate_to_page",
    title: "Open a page in the TrainingPeaks app",
    description: "Navigate this tab to a page of the TrainingPeaks web app (https://app.trainingpeaks.com), whose pages are # routes. The tab changes after this tool returns; then call get_page_context({ wait_for_settled_seconds: 10 }) and list tools again, because tool_refs can change. Passing the address already open reloads it, which is how to show changes made by add_availability or delete_availability. Pages:\n- #home - Home: the athlete's events, goals and performance summary\n- #calendar - Calendar of workouts, notes and Availability (days off); list_availability, add_availability and delete_availability work from here\n- #calendar/athletes/USER_ID/availability/AVAILABILITY_ID - Opens one Availability entry's form (user_id from get_page_context, availability_id from list_availability); its Save and Delete are left to the user or to the availability tools\n- #dashboard - Dashboard charts (fitness, fatigue, form)\n- #plan - ATP, the Annual Training Plan\n- #settings - Account and athlete settings\nExample: navigate_to_page({ url: \"#calendar\" })\nurl is a # route, a path on app.trainingpeaks.com, or a full https://app.trainingpeaks.com URL; other sites and hosts are refused (sign in with the login tool, not by opening the login page). While an Availability form is open it refuses to leave unless discard_form is true, because leaving drops unsaved edits. The result says the navigation was scheduled, not that the page loaded.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2000, pattern: "^(#|/(?!/)|https://app\\.trainingpeaks\\.com([/?#]|$))", description: "A # route such as \"#calendar\", a path on app.trainingpeaks.com, or a full https://app.trainingpeaks.com URL." },
        discard_form: { type: "boolean", default: false, description: "Leave an open Availability form, dropping unsaved edits." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "from_url", "to_url", "reload", "next_step"],
          properties: { status: { const: "navigation_scheduled" }, from_url: { type: "string" }, to_url: { type: "string" }, reload: { type: "boolean" }, next_step: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "form_open"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async input => {
    const APP = "https://app.trainingpeaks.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object, e.g. { url: \"#calendar\" }.");
    const extra = Object.keys(input).filter(k => !["url", "discard_form"].includes(k));
    if (extra.length) return fail("invalid_input", "Unknown input " + extra.join(", ") + ": pass the page as url, e.g. { url: \"#calendar\" }.");
    if (input.discard_form !== undefined && typeof input.discard_form !== "boolean") return fail("invalid_input", "discard_form must be true or false.");
    const raw = typeof input.url === "string" ? input.url.trim() : "";
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    if (!raw || raw.length > 2000 || raw.includes("\\") || (!absolute && !raw.startsWith("#") && (!raw.startsWith("/") || raw.startsWith("//")))) return fail("invalid_input", "url must be a # route such as \"#calendar\", a path starting with a single \"/\", or a full https://app.trainingpeaks.com URL.");
    let target;
    try { target = new URL(raw.startsWith("#") ? "/" + raw : raw, APP); } catch { return fail("invalid_input", "url is not a valid address."); }
    if (target.origin !== APP || target.username || target.password) return fail("invalid_input", "url must stay on https://app.trainingpeaks.com; use the login tool to sign in.");
    if (!/(^|\.)trainingpeaks\.com$/.test(location.hostname)) return fail("wrong_page", "Open a trainingpeaks.com page first.");
    const formOpen = [...document.querySelectorAll('[data-cy="availabilityEditor"]')].some(e => e.getClientRects().length > 0);
    if (formOpen && input.discard_form !== true) return fail("form_open", "An Availability form is open; leaving drops its unsaved edits. Ask the user to save or cancel it, or pass discard_form: true.");
    const from = location.href;
    const to = target.href;
    const reload = to === from || (to === APP + "/" && from === APP + "/");
    globalThis.__xwebmcpTrainingPeaksNavigation = { from, to, at: Date.now() };
    const sameDocument = location.origin === APP && target.pathname === location.pathname && target.search === location.search && !reload;
    // Return first: a reload or a cross-document navigation destroys this document and this tool's result.
    setTimeout(() => {
      if (reload) location.reload();
      else if (sameDocument) location.hash = target.hash;
      else location.assign(to);
    }, 100);
    return {
      status: "navigation_scheduled", from_url: from, to_url: to, reload,
      next_step: "Wait, then call get_page_context({ wait_for_settled_seconds: 10 }) to confirm where the tab is, and list tools again (tool_refs can change)."
    };
  }
}]
