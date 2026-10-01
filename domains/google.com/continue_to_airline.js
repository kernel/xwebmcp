[{
  kind: "cdp",
  match: { url_patterns: ["https://www.google.com/travel/flights/booking*"] },
  tool: {
    name: "continue_to_airline",
    description: "On Google Flights' booking page, press \"Continue\" for one seller's fare (seller and fare_name exactly as get_booking_options returned them). Google opens the seller's site in a NEW TAB with the chosen flights and fare already in the seller's cart (for United: its Traveler Info checkout page). The new tab belongs to the same xwebmcp session. This tool books and pays nothing; the purchase happens on the seller's site and is the user's decision. If the new tab stays on google.com/travel/clk for more than about 20 s, close it with close_tab and call this tool again. Then call list_tabs to find the new tab (new_tab_url is reported only when the tool can observe it, which is not always). Needs a trusted click, so it runs as a cdp tool.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["seller", "fare_name"],
      properties: {
        seller: { type: "string", minLength: 1, maxLength: 80, description: "e.g. \"United\"" },
        fare_name: { type: "string", minLength: 1, maxLength: 80, description: "e.g. \"Economy\"" },
        expected_price: { type: "number", minimum: 0, description: "Refuse if the fare's displayed price differs (from get_booking_options)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "seller", "fare_name", "price", "new_tab_url", "new_tab_target_id", "next_step"],
          properties: {
            status: { const: "opened" },
            seller: { type: "string" }, fare_name: { type: "string" }, price: { type: ["number", "null"] },
            new_tab_url: { type: ["string", "null"] },
            new_tab_target_id: { type: ["string", "null"] },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["not_found", "price_changed", "error"] },
            error_message: { type: "string" },
            available: { type: "array", items: { type: "string" } }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input) => {
    const seller = String(input?.seller || "").trim();
    const fare = String(input?.fare_name || "").trim();
    if (!seller || !fare) return { status: "error", error_message: "seller and fare_name are required." };
    const found = await js(({ seller, fare }) => {
      const buttons = [...document.querySelectorAll('button[aria-label^="Continue to book with"]')].filter((b) => b.getClientRects().length > 0);
      const labels = buttons.map((b) => b.getAttribute("aria-label"));
      const want = "continue to book with " + seller.toLowerCase() + ", " + fare.toLowerCase() + " for ";
      const label = labels.find((l) => l.toLowerCase().startsWith(want)) || null;
      return { label, labels, onBooking: /\/travel\/flights\/booking/.test(location.pathname) };
    }, { arg: { seller, fare } });
    if (!found.onBooking) return { status: "error", error_message: "Not on Google Flights' booking page; choose flights with select_flight first." };
    if (!found.label) return { status: "not_found", error_message: "No \"" + fare + "\" fare from " + seller + " on this booking page.", available: found.labels.map((l) => l.replace(/^Continue to book with /, "")) };
    const price = Number(((/ for ([\d,]+(?:\.\d{2})?) /.exec(found.label) || [])[1] || "").replace(/,/g, "")) || null;
    if (typeof input.expected_price === "number" && price !== null && Math.abs(price - input.expected_price) > 0.5) {
      return { status: "price_changed", error_message: "The " + fare + " fare now shows " + price + ", not " + input.expected_price + ". Nothing was pressed; call get_booking_options again." };
    }
    let before = [];
    try { before = ((await cdp("Target.getTargets")).targetInfos || []).map((t) => t.targetId); } catch {}
    await click('button[aria-label="' + found.label.replace(/"/g, '\\"') + '"]', { timeoutSec: 10 });
    let opened = null;
    for (let i = 0; i < 20 && !opened; i++) {
      await waitMs(500);
      try {
        const targets = ((await cdp("Target.getTargets")).targetInfos || []).filter((t) => t.type === "page" && !before.includes(t.targetId) && /^https?:/.test(t.url) && !/google\.com/.test(new URL(t.url).hostname));
        if (targets.length) opened = targets[0];
      } catch { break; }
    }
    return {
      status: "opened",
      seller, fare_name: fare, price,
      new_tab_url: opened ? opened.url : null,
      new_tab_target_id: opened ? opened.targetId : null,
      next_step: "The seller's site opened in a new tab of this session with the chosen flights in its cart. Call list_tabs to find it, then get_page_context (with wait_for_settled_seconds) and list_tools there. Do not purchase without the user's explicit confirmation of the itinerary and total."
    };
  }
}]
