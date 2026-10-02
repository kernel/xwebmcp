[{
  kind: "cdp",
  match: { url_patterns: ["https://resy.com/cities/*/venues/*"] },
  tool: {
    name: "open_booking_dialog",
    description: "On a Resy venue page, click one exact slot button (as the user would) to open Resy's \"Complete Your Reservation\" window, then read that window: venue, date and time, guests and seating, whether a payment card is on file or must be added, any deposit/prepayment/total lines, the cancellation policy text and the label of the final button (for example \"Reserve Now\"). It NEVER presses the final button and never books: booking only happens if the user presses it themselves (or asks you to use book_reservation). Prerequisites: signed in, and the tab on the venue page for the slot's service date and party size (navigate_to_page to /cities/{city_slug}/venues/{url_slug}?date=YYYY-MM-DD&seats=N, then get_page_context with wait_for_settled_seconds). Use local_start and seating_type exactly as get_availability returned them. If the slot is no longer offered it returns slot_unavailable with the slots the page shows now; it never picks a different slot. Use close_booking_dialog to close the window. Opening the window does not hold the table.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["local_start", "party_size"],
      properties: {
        local_start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$", description: "Slot local_start from get_availability (venue-local)." },
        seating_type: { type: ["string", "null"], maxLength: 60, description: "Slot seating_type from get_availability, e.g. Dining Room; null to accept the only slot at that time." },
        party_size: { type: "integer", minimum: 1, maximum: 20, description: "Must equal seats= in the venue page URL." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "venue_name", "when", "guests_and_seating", "payment_card_on_file", "add_card_required", "price_lines", "cancellation_policy", "other_sections", "final_button_label", "final_button_enabled", "final_button_pressed", "next_step"],
          properties: {
            status: { const: "dialog_open" },
            venue_name: { type: ["string", "null"] },
            when: { type: ["string", "null"], description: "Date and time as the dialog shows them." },
            guests_and_seating: { type: ["string", "null"] },
            payment_card_on_file: { type: ["boolean", "null"], description: "true: a saved card is selected (details never returned); false: the dialog asks for a card; null: the dialog shows no payment section (no card needed for this slot)." },
            add_card_required: { type: "boolean", description: "The dialog asks for a card and none is on file." },
            price_lines: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 }, description: "Lines with an amount (deposit, prepayment, fees, total) as shown." },
            cancellation_policy: { type: ["string", "null"], maxLength: 2000 },
            other_sections: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string", maxLength: 600 } } } },
            final_button_label: { type: ["string", "null"] },
            final_button_enabled: { type: "boolean" },
            final_button_pressed: { const: false },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "message", "visible_slots"],
          properties: {
            status: { const: "slot_unavailable" },
            message: { type: "string" },
            visible_slots: { type: "array", maxItems: 40, items: { type: "string" }, description: "Slot buttons the page shows now, as \"7:30 PM Dining Room\"." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "dialog_not_ready", "site_changed"] },
            error_message: { type: "string", minLength: 1, maxLength: 1000 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (!plain(input) || Object.keys(input).some((k) => !["local_start", "seating_type", "party_size"].includes(k))) return fail("invalid_input", "Input must be { local_start, seating_type, party_size }.");
    const m = typeof input.local_start === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(input.local_start) : null;
    if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) return fail("invalid_input", "local_start must be YYYY-MM-DDTHH:MM from get_availability.");
    if (!Number.isInteger(input.party_size) || input.party_size < 1 || input.party_size > 20) return fail("invalid_input", "party_size must be 1..20.");
    const seating = input.seating_type === undefined || input.seating_type === null ? null : String(input.seating_type).trim();
    const hour = Number(m[2]);
    const label = (hour % 12 || 12) + ":" + m[3] + " " + (hour < 12 ? "AM" : "PM");

    const page = await js((arg) => {
      const params = new URLSearchParams(location.search);
      const seg = location.pathname.split("/").filter(Boolean);
      const token = window.apiAuthToken;
      return {
        venue: seg[0] === "cities" && seg[2] === "venues" && seg[3] && !seg[4],
        path: "/" + seg.slice(0, 4).join("/"),
        date: params.get("date"), seats: params.get("seats"),
        signedIn: typeof token === "string" && !!token && token !== "undefined" && token !== "null",
        open: [...document.querySelectorAll("iframe")].some((f) => /^https:\/\/widgets\.resy\.com\//.test(f.src || "") && f.getBoundingClientRect().height > 50)
      };
    });
    if (!page.venue) return fail("wrong_page", "Open the venue page first: navigate_to_page({ url: \"/cities/{city_slug}/venues/{url_slug}?date=" + m[1] + "&seats=" + input.party_size + "\" }).");
    const nextDay = new Date(Date.parse(m[1] + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    const dateOk = page.date === m[1] || (hour < 6 && page.date === nextDay);
    if (!dateOk || String(page.seats) !== String(input.party_size)) {
      return fail("wrong_page", "This venue page shows date " + page.date + " and " + page.seats + " seats. Use navigate_to_page({ url: \"" + page.path + "?date=" + (hour < 6 && page.date === nextDay ? page.date : m[1]) + "&seats=" + input.party_size + "\" }), then get_page_context with wait_for_settled_seconds, then call this again.");
    }
    if (!page.signedIn) return fail("login_required", "Resy's booking window needs a signed-in account. Ask the user to sign in (or use login with credentials they supplied).");
    if (page.open) return fail("wrong_page", "A booking window is already open. Call close_booking_dialog first, then open the slot you want.");

    // Find and click the exact slot button; wait for the slot list to render.
    let pick = null;
    for (let i = 0; i < 40; i++) {
      pick = await js((arg) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const buttons = [...document.querySelectorAll("button.ReservationButton")].filter((b) => b.getClientRects().length);
        const listed = buttons.map((b) => norm(b.innerText));
        const timeOf = (t) => (/^(\d{1,2}:\d{2} [AP]M)/.exec(t) || [])[1];
        const hits = buttons.filter((b) => {
          const t = norm(b.innerText);
          if (timeOf(t) !== arg.label) return false;
          return arg.seating === null || norm(t.slice(arg.label.length)).toLowerCase() === arg.seating.toLowerCase();
        });
        const loading = !buttons.length && !document.querySelector("h1");
        if (hits.length === 1 && !hits[0].disabled) { hits[0].scrollIntoView({ block: "center" }); hits[0].click(); return { clicked: true, listed }; }
        return { clicked: false, ambiguous: hits.length > 1, loading, listed };
      }, { arg: { label, seating } });
      if (pick.clicked || pick.ambiguous || (!pick.loading && i >= 6)) break;
      await waitMs(250);
    }
    if (pick.ambiguous) return fail("invalid_input", "Several slots at " + label + " match; pass seating_type exactly as get_availability gave it. Visible: " + pick.listed.slice(0, 20).join("; "));
    if (!pick.clicked) return { status: "slot_unavailable", message: "The venue page does not show a " + label + (seating ? " " + seating : "") + " slot for this date and party size" + (pick.listed.some((t) => t.startsWith(label)) ? " (that time is shown with a different seating type)" : "") + ": either Resy never offered it or it was just taken. Nothing was opened or booked. Re-check get_availability and ask the user before choosing another slot.", visible_slots: pick.listed.slice(0, 40) };

    const pageVenue = await js(() => { const h = document.querySelector("h1"); const t = h ? (h.textContent || "").replace(/\s+/g, " ").trim() : ""; return t ? t.slice(0, 200) : null; });
    // Read the cross-origin widgets.resy.com booking frame (only reachable through CDP).
    const readFrame = async () => {
      const tree = await cdp("Page.getFrameTree", {});
      const frames = [];
      const walk = (f) => { frames.push(f.frame); (f.childFrames || []).forEach(walk); };
      walk(tree.frameTree);
      const frame = frames.find((f) => /^https:\/\/widgets\.resy\.com\//.test(f.url || ""));
      if (!frame) return null;
      const world = await cdp("Page.createIsolatedWorld", { frameId: frame.id, worldName: "xwebmcp-resy-booking" });
      const res = await cdp("Runtime.evaluate", {
        contextId: world.executionContextId, returnByValue: true, awaitPromise: false,
        expression: `(() => {
          const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
          const vis = (e) => !!e && e.getClientRects().length > 0;
          const body = norm(document.body && document.body.textContent);
          const root = document.querySelector(".SummaryPage__ScrollView") || document.querySelector(".SummaryPage") || document.body;
          const summary = root.querySelector(".ReservationSummary");
          const rows = summary ? [...summary.querySelectorAll(".ReservationSummary__row")].map((r) => norm(r.textContent)) : [];
          const sections = [...root.querySelectorAll("section.SummarySection")].map((s) => ({ title: norm(s.querySelector(".SummarySectionHeader") && s.querySelector(".SummarySectionHeader").textContent), body: s.querySelector(".SummarySectionBody") }));
          const book = [...document.querySelectorAll(".SummaryPage__book button, button[data-test-id='order_summary_page-button-book']")].find(vis);
          const prices = rows.slice(2).filter((t) => /\\$\\s?\\d/.test(t));
          for (const row of root.querySelectorAll(".OrderSummary__item, .OrderSummary__section--body__row")) {
            const cells = [...row.children];
            if (cells.length < 2) continue;
            const qty = row.querySelector(".OrderSummary__item--quantity");
            const q = qty ? norm(qty.textContent) : "";
            let label = norm(cells[0].textContent);
            if (q && label.endsWith(q)) label = norm(label.slice(0, -q.length)); else if (q && label.startsWith(q)) label = norm(label.slice(q.length));
            label = label.replace(/^:\\s*/, "").replace(/:$/, "");
            const amount = norm(cells[cells.length - 1].textContent);
            const line = label + (q ? " x" + q : "") + ": " + amount;
            if (/\\$\\s?\\d/.test(amount) && line.length <= 300 && !prices.includes(line)) prices.push(line);
          }
          return {
            ready: !!summary && !!book && sections.length > 0 && !!book && !book.disabled,
            partial: !!summary && !!book,
            error: /no longer available|sorry|something went wrong|unable to/i.test(body) && !summary ? body.slice(0, 300) : null,
            venue: summary ? norm(summary.querySelector(".ReservationSummary__title") && summary.querySelector(".ReservationSummary__title").textContent) : null,
            when: rows[0] || null, guests: rows[1] || null,
            cardOnFile: sections.some((s) => /payment/i.test(s.title) && /card ending/i.test(norm(s.body && s.body.textContent))),
            paymentShown: sections.some((s) => /payment/i.test(s.title)),
            addCard: sections.some((s) => /payment/i.test(s.title) && !/card ending/i.test(norm(s.body && s.body.textContent))),
            cancellation: (sections.find((s) => /cancel/i.test(s.title)) || {}).body ? norm(sections.find((s) => /cancel/i.test(s.title)).body.textContent).slice(0, 2000) : null,
            other: sections.filter((s) => s.title && !/payment|cancel|order summary/i.test(s.title)).map((s) => ({ title: s.title.slice(0, 120), text: norm(s.body && s.body.textContent).slice(0, 600) })).slice(0, 10),
            prices: prices.slice(0, 20),
            button: book ? norm(book.textContent) : null,
            enabled: !!book && !book.disabled && book.getAttribute("aria-disabled") !== "true"
          };
        })()`
      });
      return res && res.result ? res.result.value : null;
    };
    let seen = null;
    let lastError = null;
    for (let i = 0; i < 60; i++) {
      await waitMs(250);
      try { seen = await readFrame(); } catch (e) { seen = null; lastError = String(e && e.message || e).slice(0, 200); }
      if (seen && (seen.ready || seen.error)) break;
      if (seen && seen.partial && i >= 40) break;
    }
    if (seen && seen.ready) {
      // Let the window finish painting, then read the final state once more.
      await waitMs(800);
      try { const again = await readFrame(); if (again && again.ready) seen = again; } catch { /* keep the first complete read */ }
    }
    if (seen && seen.error) return { status: "slot_unavailable", message: "Resy's booking window says: " + seen.error + ". Nothing was booked. Call close_booking_dialog, re-check get_availability and ask the user before choosing another slot.", visible_slots: pick.listed.slice(0, 40) };
    if (!seen || !(seen.ready || seen.partial)) return fail("dialog_not_ready", "Clicked the " + label + " slot but Resy's booking window did not finish loading within 15 s" + (lastError ? " (" + lastError + ")" : "") + ". Call get_page_context; if pending_choice is booking_dialog, call close_booking_dialog before retrying.");
    return {
      status: "dialog_open",
      venue_name: seen.venue || pageVenue || null,
      when: seen.when || null,
      guests_and_seating: seen.guests || null,
      payment_card_on_file: seen.paymentShown ? !!seen.cardOnFile : null,
      add_card_required: !!seen.addCard,
      price_lines: seen.prices,
      cancellation_policy: seen.cancellation,
      other_sections: seen.other,
      final_button_label: seen.button,
      final_button_enabled: !!seen.enabled,
      final_button_pressed: false,
      next_step: "Show the user these exact details. \"" + (seen.button || "Reserve Now") + "\" is the final booking step: do not press it; the user decides. Use close_booking_dialog to close the window without booking."
    };
  }
}]
