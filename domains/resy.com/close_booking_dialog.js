[{
  kind: "cdp",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "close_booking_dialog",
    description: "Close Resy's open \"Complete Your Reservation\" window (opened by open_booking_dialog or by clicking a slot) with its close (X) button, without booking. Never presses Reserve Now. Returns not_open when no booking window is open.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["status"], properties: { status: { enum: ["closed", "not_open"] } } },
        { type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"], properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "site_changed"] }, error_message: { type: "string", minLength: 1 } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input) => {
    if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) return { status: "error", error_kind: "invalid_input", error_message: "Input must be an empty object." };
    const isOpen = () => js(() => [...document.querySelectorAll("iframe")].some((f) => /^https:\/\/widgets\.resy\.com\//.test(f.src || "") && f.getBoundingClientRect().height > 50));
    if (!(await isOpen())) return { status: "not_open" };
    const tree = await cdp("Page.getFrameTree", {});
    const frames = [];
    const walk = (f) => { frames.push(f.frame); (f.childFrames || []).forEach(walk); };
    walk(tree.frameTree);
    const frame = frames.find((f) => /^https:\/\/widgets\.resy\.com\//.test(f.url || ""));
    if (!frame) return { status: "error", error_kind: "site_changed", error_message: "A booking window is visible but its frame was not found." };
    const world = await cdp("Page.createIsolatedWorld", { frameId: frame.id, worldName: "xwebmcp-resy-close" });
    const res = await cdp("Runtime.evaluate", {
      contextId: world.executionContextId, returnByValue: true,
      expression: `(() => { const b = [...document.querySelectorAll("button.WidgetNav__close, button[aria-label='Close']")].find((e) => e.getClientRects().length); if (!b) return false; b.click(); return true; })()`
    });
    if (!res || !res.result || res.result.value !== true) return { status: "error", error_kind: "site_changed", error_message: "The booking window has no visible close button; the user can close it with its X." };
    for (let i = 0; i < 20; i++) { await waitMs(250); if (!(await isOpen())) return { status: "closed" }; }
    return { status: "error", error_kind: "site_changed", error_message: "Clicked close but the booking window is still visible; check get_page_context." };
  }
}]
