[{
  kind: "cdp",
  match: { url_patterns: ["https://www.google.com/travel/flights/booking*"] },
  tool: {
    name: "continue_to_airline",
    description: "On Google Flights' booking page, press \"Continue\" for one booking option: seller, and fare_name when the seller lists several fares, exactly as get_booking_options returned them (omit fare_name or pass null for sellers without per-fare cards, such as most travel agencies). Options collapsed behind \"N more booking options\" are expanded first. Google opens the seller's site in a NEW TAB with the chosen flights and fare already in the seller's cart (for United: its Traveler Info checkout page). The new tab belongs to the same xwebmcp session. This tool books and pays nothing; the purchase happens on the seller's site and is the user's decision. If the new tab stays on google.com/travel/clk for more than about 20 s, close it with close_tab and call this tool again. Then call list_tabs to find the new tab (new_tab_url is reported only when the tool can observe it, which is not always). Needs a trusted click, so it runs as a cdp tool.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["seller"],
      properties: {
        seller: { type: "string", minLength: 1, maxLength: 80, description: "e.g. \"United\"" },
        fare_name: { type: ["string", "null"], minLength: 1, maxLength: 80, description: "e.g. \"Economy\"; omit or null for a seller without per-fare cards." },
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
            seller: { type: "string" }, fare_name: { type: ["string", "null"] }, price: { type: ["number", "null"] },
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
  execute: async (input, context = {}) => {
    const seller = String(input?.seller || "").trim();
    const fare = String(input?.fare_name || "").trim() || null;
    if (!seller) return { status: "error", error_message: "seller is required." };
    // Act on the tab the tool was invoked for, in the foreground: a seller tab opened by an earlier call takes focus,
    // and clicks in a background tab never settle.
    const target = context.matches?.[0]?.top_target_id;
    if (target && (await currentTab()).targetId !== target) await switchTab(target);
    await cdp("Page.bringToFront");
    const found = await js(({ seller, fare }) => {
      const labels = [...new Set([...document.querySelectorAll('button[aria-label^="Continue to book with"]')].map((b) => b.getAttribute("aria-label")))];
      // Same label grammar as get_booking_options: "<seller>, <fare> for …", "<airline(s)> airline for …", "<agency> for …".
      const parse = (aria) => {
        const m = /^Continue to book with (.+?) for ([\d,]+(?:\.\d+)?) /.exec(aria.replace(/\s+/g, " "));
        if (!m) return null;
        const direct = / airline$/.exec(m[1]);
        const comma = m[1].indexOf(", ");
        return {
          label: aria,
          seller: direct ? m[1].slice(0, direct.index) : comma > 0 ? m[1].slice(0, comma) : m[1],
          fare: direct || comma < 0 ? null : m[1].slice(comma + 2),
          price: Number(m[2].replace(/,/g, ""))
        };
      };
      const options = labels.map(parse).filter(Boolean);
      const same = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
      const bySeller = options.filter((o) => same(o.seller, seller));
      const matches = fare ? bySeller.filter((o) => same(o.fare, fare)) : bySeller.filter((o) => o.fare === null).length ? bySeller.filter((o) => o.fare === null) : bySeller;
      return { match: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1, labels, onBooking: /\/travel\/flights\/booking/.test(location.pathname) };
    }, { arg: { seller, fare } });
    if (!found.onBooking) return { status: "error", error_message: "Not on Google Flights' booking page; choose flights with select_flight first." };
    const available = found.labels.map((l) => l.replace(/^Continue to book with /, ""));
    if (found.ambiguous) return { status: "not_found", error_message: seller + " lists several fares; pass fare_name exactly as get_booking_options returned it.", available };
    if (!found.match) return { status: "not_found", error_message: "No " + (fare ? "\"" + fare + "\" fare from " : "option from ") + seller + " on this booking page.", available };
    const price = found.match.price;
    if (typeof input.expected_price === "number" && Math.abs(price - input.expected_price) > 0.5) {
      return { status: "price_changed", error_message: "The " + (fare || seller) + " option now shows " + price + ", not " + input.expected_price + ". Nothing was pressed; call get_booking_options again." };
    }
    const selector = 'button[aria-label="' + found.match.label.replace(/"/g, '\\"') + '"]';
    if (!await waitForElement(selector, { state: "visible", timeoutSec: 1 })) {
      await click('button[aria-label$="more booking options"]', { timeoutSec: 10 });
      if (!await waitForElement(selector, { state: "visible", timeoutSec: 10 })) return { status: "error", error_message: "The option is collapsed and did not appear after expanding \"more booking options\". Nothing was pressed." };
    }
    let before = [];
    try { before = ((await cdp("Target.getTargets")).targetInfos || []).map((t) => t.targetId); } catch {}
    await click(selector, { timeoutSec: 10 });
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
      seller: found.match.seller, fare_name: found.match.fare, price,
      new_tab_url: opened ? opened.url : null,
      new_tab_target_id: opened ? opened.targetId : null,
      next_step: "The seller's site opened in a new tab of this session with the chosen flights in its cart. Call list_tabs to find it, then get_page_context (with wait_for_settled_seconds) and list_tools there. Do not purchase without the user's explicit confirmation of the itinerary and total."
    };
  }
}]
