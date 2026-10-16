[{
  kind: "page",
  match: { url_patterns: ["https://secure.booking.com/*"] },
  tool: {
    name: "get_checkout_step",
    description: "Read Booking.com's checkout page open in this tab (secure.booking.com/book.html, reached with select_room): the current step (your_details or finish_booking), the property, check-in and check-out dates and times, what is selected (nights, rooms, party and room names), the total including taxes and fees with its currency, the taxes note, the cancellation policy and whether the browser is signed in. Read-only: never types, clicks or navigates. Elsewhere it returns wrong_page. English pages only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "step", "property_id", "property_name", "check_in", "check_out", "check_in_time", "check_out_time", "selection", "units", "total", "currency", "total_text", "price_notes", "cancellation", "signed_in"],
          properties: {
            status: { const: "ok" },
            step: { enum: ["your_details", "finish_booking", "other"], description: "your_details asks for the guest's name and contact details; finish_booking asks for payment." },
            property_id: { type: ["string", "null"] }, property_name: { type: ["string", "null"], maxLength: 300 },
            check_in: { type: ["string", "null"], description: "YYYY-MM-DD" }, check_out: { type: ["string", "null"], description: "YYYY-MM-DD" },
            check_in_time: { type: ["string", "null"], maxLength: 100 }, check_out_time: { type: ["string", "null"], maxLength: 100 },
            selection: { type: ["string", "null"], maxLength: 300, description: "For example \"2 nights, 1 room for 2 adults\"." },
            units: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 }, description: "Selected rooms, for example \"1 x Double or Twin Room\"." },
            total: { type: ["number", "null"], description: "The price summary's total, which Booking.com says includes taxes and fees unless price_notes says otherwise." },
            currency: { type: ["string", "null"] }, total_text: { type: ["string", "null"], maxLength: 100 },
            price_notes: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 }, description: "Lines under the total, such as \"Includes taxes and fees\" or the amount in the property's currency." },
            cancellation: { type: ["string", "null"], maxLength: 300 },
            signed_in: { type: ["boolean", "null"] }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "site_changed"] },
            error_message: { type: "string", maxLength: 600 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) return fail("invalid_input", "This tool takes no input.");
    if (window.location.origin !== "https://secure.booking.com" || window.location.pathname !== "/book.html") return fail("wrong_page", "This is not Booking.com's checkout page; use select_room on a property page to get there.");
    if (!/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "")) return fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.");

    const text = (el, max = 300) => el ? (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, max) || null : null;
    // The text of each innermost element, in document order: one entry per line the page shows.
    const lines = el => el ? [...el.querySelectorAll("*")].filter(e => !e.children.length).map(e => text(e, 1000)).filter(Boolean) : [];
    const tid = id => document.querySelector('[data-testid="' + id + '"]');
    const scripts = [...document.querySelectorAll("script")].map(s => s.textContent || "").join("\n");
    const isoDate = value => {
      const time = Date.parse(value || "");
      if (!Number.isFinite(time)) return null;
      const d = new Date(time);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    };
    const heading = re => [...document.querySelectorAll("h1, h2, h3")].find(h => re.test(h.textContent || ""));
    const container = (h, min) => { let c = h; while (c && c.parentElement && lines(c).length < min) c = c.parentElement; return c; };

    const dates = tid("booking-details-date-summary");
    const times = dates ? [...dates.querySelectorAll("time")] : [];
    const priceHeading = heading(/^\s*Your price summary\s*$/i);
    const totalEl = document.querySelector('[data-animate-price-group-name="bp_user_total_price"]');
    if (!dates || times.length !== 2 || !priceHeading || !totalEl) return fail("site_changed", "The checkout page does not show the booking details and price summary this tool reads; Booking.com's page may have changed or still be loading.");

    const timeLines = times.map(t => lines(t));
    const detailsHeading = heading(/^\s*Your booking details\s*$/i);
    const details = detailsHeading ? container(detailsHeading, 6) : null;
    const detailLines = lines(details);
    const selectedAt = detailLines.indexOf("You selected");
    const units = details ? [...details.querySelectorAll("li")].map(li => text(li)).filter(Boolean).slice(0, 20) : [];
    let summary = totalEl;
    while (summary.parentElement && !summary.contains(priceHeading)) summary = summary.parentElement;
    const summaryLines = lines(summary);
    const totalAt = summaryLines.indexOf("Total");
    const value = Number(totalEl.getAttribute("data-value"));
    const currency = totalEl.getAttribute("data-currency");
    const totalText = text(totalEl, 100);
    const after = totalAt >= 0 ? summaryLines.slice(totalAt + 1) : [];
    const end = after.indexOf("Price information");
    const notes = after.slice(0, end < 0 ? undefined : end).filter(line => line !== totalText).slice(0, 10).map(line => line.slice(0, 300));
    const profile = !!tid("header-profile"), signIn = !!tid("header-sign-in-button");
    const hotelId = (/\bb_hotel_id\s*[:=]\s*['"]?(\d+)/.exec(scripts) || [])[1] || null;
    const step = tid("user-details-container") ? "your_details" : document.querySelector('[data-testid*="payment"], iframe[src*="payment"]') ? "finish_booking" : "other";
    const nameEl = document.querySelector('[data-testid="property-details__metadata--property-type"]')?.closest("div")?.parentElement?.querySelector("h1, h2") || document.querySelector("h1, h2");
    return {
      status: "ok", step, property_id: hotelId, property_name: text(nameEl),
      check_in: isoDate(times[0].getAttribute("datetime")), check_out: isoDate(times[1].getAttribute("datetime")),
      check_in_time: timeLines[0][2] ? timeLines[0][2].slice(0, 100) : null, check_out_time: timeLines[1][2] ? timeLines[1][2].slice(0, 100) : null,
      selection: selectedAt >= 0 && detailLines[selectedAt + 1] ? detailLines[selectedAt + 1].slice(0, 300) : null,
      units,
      total: Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null,
      currency: /^[A-Z]{3}$/.test(currency || "") ? currency : null,
      total_text: totalText, price_notes: notes,
      cancellation: text(tid("cancellation-policy")),
      signed_in: profile === signIn ? null : profile
    };
  }
}]
