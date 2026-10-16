[{
  kind: "page",
  match: { url_patterns: ["https://secure.booking.com/*"] },
  tool: {
    name: "get_checkout_step",
    description: "Read Booking.com's checkout page open in this tab, reached with select_room: secure.booking.com/book.html, or tpi_book for a Partner Offer (partner_offer true): the current step (your_details or finish_booking), the property, check-in and check-out dates and times, what is selected (nights, rooms, party and room names), the total including taxes and fees with its currency, the taxes note, the cancellation policy and whether the browser is signed in. Read-only: never types, clicks or navigates. Elsewhere it returns wrong_page. English pages only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "step", "partner_offer", "property_id", "property_name", "check_in", "check_out", "check_in_time", "check_out_time", "selection", "units", "total", "currency", "total_text", "price_notes", "cancellation", "signed_in"],
          properties: {
            status: { const: "ok" },
            step: { enum: ["your_details", "finish_booking", "other"], description: "your_details asks for the guest's name and contact details; finish_booking asks for payment." },
            partner_offer: { type: "boolean", description: "True on the partner checkout (tpi_book) a Partner Offer opens. Its price and cancellation terms are the partner's and can differ from the property page." },
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
    const partnerPage = /^\/tpi_book(?:\.[a-z]{2}(?:-[a-z]{2})?)?\.html$/.test(window.location.pathname);
    if (window.location.origin !== "https://secure.booking.com" || (window.location.pathname !== "/book.html" && !partnerPage)) return fail("wrong_page", "This is not Booking.com's checkout page; use select_room on a property page to get there.");
    if (!/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "")) return fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.");

    const text = (el, max = 300) => el ? (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, max) || null : null;
    // The innermost elements, in document order: one per line the page shows.
    const leaves = el => el ? [...el.querySelectorAll("*")].filter(e => !e.children.length && text(e)) : [];
    const lines = el => leaves(el).map(e => text(e, 1000));
    const tid = id => document.querySelector('[data-testid="' + id + '"]');
    const scripts = [...document.querySelectorAll("script")].map(s => s.textContent || "").join("\n");
    const isoDate = value => {
      const time = Date.parse(value || "");
      if (!Number.isFinite(time)) return null;
      const d = new Date(time);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    };
    const amount = value => { const m = /[\d][\d,]*(?:\.\d+)?/.exec(value || ""); return m ? Number(m[0].replace(/,/g, "")) : null; };
    const heading = re => [...document.querySelectorAll("h1, h2, h3, div")].find(h => !h.children.length && re.test(h.textContent || ""));
    const container = (h, min) => { let c = h; while (c && c.parentElement && lines(c).length < min) c = c.parentElement; return c; };
    // A visible line with exactly this text; the partner page also hides a date picker with the same labels.
    const label = re => [...document.body.querySelectorAll("div, span, strong, h3")].find(e => !e.children.length && re.test(text(e) || "") && e.getClientRects().length);

    const priceHeading = heading(/^\s*Your price summary\s*$/i);
    const detailsHeading = heading(/^\s*Your booking details\s*$/i);
    const totalEl = document.querySelector('[data-animate-price-group-name="bp_user_total_price"]');
    const totalLabel = totalEl ? null : label(/^Total(?: price)?$/);
    const totalText = totalEl ? text(totalEl, 100) : text(totalLabel?.nextElementSibling, 100);
    const total = totalEl ? Number(totalEl.getAttribute("data-value")) : amount(totalText);

    // Dates: Booking.com's own checkout and one partner layout use a date summary; the other partner layout labels them.
    const dates = tid("booking-details-date-summary");
    const times = dates ? [...dates.querySelectorAll("time")] : [];
    let checkIn, checkOut;
    if (times.length === 2) {
      [checkIn, checkOut] = times.map(t => { const l = lines(t); return { date: isoDate(t.getAttribute("datetime")), time: l[2] ? l[2].slice(0, 100) : null }; });
    } else {
      const stay = re => { const m = /^(?:[A-Za-z]+, )?([A-Za-z]+ \d{1,2}, \d{4})\s*(.*)$/.exec(text(label(re)?.nextElementSibling) || ""); return { date: m ? isoDate(m[1]) : null, time: m && m[2] ? m[2].slice(0, 100) : null }; };
      checkIn = stay(/^Check-in:$/);
      checkOut = stay(/^Check-out:$/);
    }
    if (!priceHeading || !checkIn.date || !checkOut.date || !Number.isFinite(total) || total === null || total < 0) return fail("site_changed", "The checkout page does not show the booking details and price summary this tool reads; Booking.com's page may have changed or still be loading.");

    const details = detailsHeading ? container(detailsHeading, 6) : null;
    const detailLines = lines(details);
    const selectedAt = detailLines.indexOf("You selected");
    let selection = selectedAt >= 0 && detailLines[selectedAt + 1] ? detailLines[selectedAt + 1].slice(0, 300) : null;
    let units = selectedAt >= 0 ? [...details.querySelectorAll("li")].map(li => text(li)).filter(Boolean).slice(0, 20) : [];
    if (selectedAt < 0 && partnerPage) {
      // The labelled partner layout shows only the length of stay; the party comes from the checkout URL, and the
      // room's name only when the page labels its guests.
      const params = new URL(window.location.href).searchParams;
      const count = name => /^\d{1,2}$/.test(params.get(name) || "") ? Number(params.get(name)) : null;
      const rooms = count("num_rooms"), adults = count("num_adults"), children = count("num_children");
      const party = rooms && adults ? rooms + (rooms === 1 ? " room" : " rooms") + " for " + adults + (adults === 1 ? " adult" : " adults") + (children ? ", " + children + (children === 1 ? " child" : " children") : "") : null;
      selection = [text(label(/^Total length of stay:$/)?.nextElementSibling), party].filter(Boolean).join(", ").slice(0, 300) || null;
      units = [...document.body.querySelectorAll("strong")].filter(e => text(e) === "Guests:").map(e => { let c = e; while (c && !c.querySelector("h2")) c = c.parentElement; return text(c?.querySelector("h2")); }).filter(Boolean).slice(0, 20);
    }

    let summary = totalEl || totalLabel;
    while (summary.parentElement && !summary.contains(priceHeading)) summary = summary.parentElement;
    const summaryLines = lines(summary);
    const stop = line => line === "Price information" || line === "How much will it cost to cancel?";
    let notes;
    if (totalEl) {
      const totalAt = summaryLines.indexOf("Total");
      const after = totalAt >= 0 ? summaryLines.slice(totalAt + 1) : [];
      const end = after.findIndex(stop);
      notes = after.slice(0, end < 0 ? undefined : end).filter(line => line !== totalText);
    } else {
      // Partner checkouts split what is paid now and at the property, above the total.
      const from = summaryLines.indexOf(text(priceHeading));
      const rest = summaryLines.slice(from + 1);
      const end = rest.findIndex(stop);
      notes = rest.slice(0, end < 0 ? undefined : end).filter(line => line !== text(totalLabel) && line !== totalText);
    }
    const all = lines(document.body);
    const cancelAt = all.indexOf("How much will it cost to cancel?");
    const profile = !!tid("header-profile"), signIn = !!tid("header-sign-in-button");
    const hotelId = (/\bb_hotel_id\s*[:=]\s*['"]?(\d+)/.exec(scripts) || [])[1] || null;
    const step = tid("user-details-container") || (partnerPage && all.some(line => /^(?:Your Details|Enter your details)\. Step 2 of 3\.$/.test(line))) ? "your_details" : document.querySelector('[data-testid*="payment"], iframe[src*="payment"]') ? "finish_booking" : "other";
    const nameEl = document.querySelector('[data-testid="property-details__metadata--property-type"]')?.closest("div")?.parentElement?.querySelector("h1, h2") || document.querySelector("h1, h2");
    const currency = totalEl ? totalEl.getAttribute("data-currency") : text(tid("header-currency-picker-trigger"));
    return {
      status: "ok", step, partner_offer: partnerPage || all.includes("Partner Offer"), property_id: hotelId, property_name: text(nameEl),
      check_in: checkIn.date, check_out: checkOut.date, check_in_time: checkIn.time, check_out_time: checkOut.time,
      selection, units,
      total: Math.round(total * 100) / 100,
      currency: /^[A-Z]{3}$/.test(currency || "") ? currency : null,
      total_text: totalText, price_notes: notes.slice(0, 10).map(line => line.slice(0, 300)),
      cancellation: text(tid("cancellation-policy")) || (cancelAt >= 0 && all[cancelAt + 1] ? all[cancelAt + 1].slice(0, 300) : null),
      signed_in: profile === signIn ? null : profile
    };
  }
}]
