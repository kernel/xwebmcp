[{
  kind: "cdp",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "preview_tickets",
    title: "Price AMC tickets without creating an order",
    description: "Price tickets for one AMC showtime the way a person does before buying, without creating an order: open the showtime's seat page, pick the given seats, choose ticket types and counts on the ticket page, and read each type's price with fees, then stop. It NEVER presses the ticket page's Continue, so AMC creates no order, holds no seats and counts no cart toward its rate limit; seats can still be taken by others at any moment. Returns the movie, theatre, date and time, the seats, each ticket line with its price, fee and line total, the subtotal with fees (before taxes, which AMC adds in the cart), and any pricing notice. Show these to the user; if they want the seats held, call add_tickets_to_cart with the same showtime_id, seats and tickets and expected_subtotal set to this subtotal, which refuses if the price has changed. Inputs and refusals match add_tickets_to_cart: showtime_id from get_showtimes, seat names from get_seat_map (for example F7), ticket counts adding up to the number of seats, and wheelchair spaces and companion seats refused unless accessible_seating is true. Leaves the tab on the ticket page with these choices made; it never adds food, signs in, applies rewards or pays. Refuses while this tab shows a cart or one of its edit pages.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["showtime_id", "seats", "tickets"],
      properties: {
        showtime_id: { type: ["integer", "string"], minimum: 1, maximum: 2147483647, pattern: "^[1-9][0-9]{0,9}$", description: "From get_showtimes; a number or its digits as a string." },
        seats: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", pattern: "^[A-Z]{1,3}[0-9]{1,3}$" }, description: "Seat names as AMC shows them, for example [\"F7\", \"F8\"]." },
        tickets: {
          type: "array", minItems: 1, maxItems: 6,
          items: {
            type: "object", additionalProperties: false, required: ["type", "quantity"],
            properties: { type: { type: "string", minLength: 1, maxLength: 40, description: "Ticket type as AMC lists it for the showtime, for example Adult, Child or Senior." }, quantity: { type: "integer", minimum: 1, maximum: 10 } }
          }
        },
        accessible_seating: { type: "boolean", default: false, description: "Allow wheelchair spaces and companion seats, for a guest who needs them." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "showtime_id", "showtime", "seats", "lines", "currency", "expected_subtotal", "notice", "continue_pressed", "next_step", "observed_at"],
          properties: {
            status: { const: "ok" },
            showtime_id: { type: "integer" },
            showtime: {
              type: "object", additionalProperties: false, required: ["movie", "theatre", "date", "time"],
              properties: { movie: { type: ["string", "null"] }, theatre: { type: ["string", "null"] }, date: { type: ["string", "null"] }, time: { type: ["string", "null"] } }
            },
            seats: { type: "array", maxItems: 10, items: { type: "string" } },
            lines: {
              type: "array", minItems: 1, maxItems: 6,
              items: {
                type: "object", additionalProperties: false, required: ["ticket_type", "quantity", "price_with_fees", "price", "convenience_fee", "line_total"],
                properties: {
                  ticket_type: { type: "string" },
                  quantity: { type: "integer", minimum: 1 },
                  price_with_fees: { type: "number", description: "USD per ticket as AMC lists it." },
                  price: { type: ["number", "null"] },
                  convenience_fee: { type: ["number", "null"] },
                  line_total: { type: "number" }
                }
              }
            },
            currency: { const: "USD" },
            expected_subtotal: { type: "number", description: "Sum of the ticket page's line totals, before taxes and before discounts AMC applies only in the cart (for example its Tuesday and Wednesday savings), so the cart total can be lower. Pass it to add_tickets_to_cart." },
            notice: { type: ["string", "null"], description: "AMC's pricing notice on the ticket page, for example a discount matinee." },
            continue_pressed: { const: false },
            next_step: { type: "string" },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "cart_in_progress", "not_found", "seat_unavailable", "invalid_ticket_type", "not_ready", "challenge", "site_error", "canceled"] },
            error_message: { type: "string" },
            available: { type: "array", maxItems: 20, items: { type: "string" }, description: "For invalid_ticket_type, the ticket types AMC offers." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, ...extra });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["showtime_id", "seats", "tickets", "accessible_seating"].includes(k))) return fail("invalid_input", "Provide showtime_id, seats and tickets, and optionally accessible_seating.");
    const id = typeof input.showtime_id === "string" && /^[1-9][0-9]{0,9}$/.test(input.showtime_id) ? Number(input.showtime_id) : input.showtime_id;
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) return fail("invalid_input", "showtime_id must be a positive integer from get_showtimes.");
    const seats = input.seats;
    if (!Array.isArray(seats) || !seats.length || seats.length > 10 || seats.some(s => typeof s !== "string" || !/^[A-Z]{1,3}[0-9]{1,3}$/.test(s)) || new Set(seats).size !== seats.length) return fail("invalid_input", "seats must be 1-10 distinct seat names such as F7.");
    const tickets = input.tickets;
    if (!Array.isArray(tickets) || !tickets.length || tickets.length > 6 || tickets.some(t => !t || typeof t !== "object" || Object.keys(t).some(k => !["type", "quantity"].includes(k)) || typeof t.type !== "string" || !t.type.trim() || t.type.length > 40 || !Number.isInteger(t.quantity) || t.quantity < 1 || t.quantity > 10)) return fail("invalid_input", "tickets must list ticket types with quantities, for example [{\"type\": \"Adult\", \"quantity\": 2}].");
    const types = tickets.map(t => t.type.trim().toLowerCase());
    if (new Set(types).size !== types.length) return fail("invalid_input", "List each ticket type once.");
    if (tickets.reduce((n, t) => n + t.quantity, 0) !== seats.length) return fail("invalid_input", "The ticket quantities must add up to the number of seats.");
    if (input.accessible_seating !== undefined && typeof input.accessible_seating !== "boolean") return fail("invalid_input", "accessible_seating must be true or false.");
    const canceled = () => context?.signal?.aborted ? fail("canceled", "The call was canceled; no order was created.") : null;
    if (canceled()) return canceled();

    const page = () => js(() => ({ origin: location.origin, path: location.pathname, search: location.search, title: document.title, ready: document.readyState, missing: [...document.querySelectorAll("h1, h2")].some(h => h.textContent.trim() === "Error 404") }));
    const challenged = p => /just a moment|attention required|access denied/i.test(p.title || "");
    const start = await page();
    if (start.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.amctheatres.com page first.");
    // Leaving a cart does not release its seats, so a preview never navigates away from one.
    // AMC's 404 page in place of an order (it expired or was released) holds nothing.
    if (!start.missing && (/^\/orders\//.test(start.path) || /[?&]order-token=/.test(start.search || ""))) return fail("cart_in_progress", "The tab shows an AMC cart, or a ticket page opened from a cart's Edit link. Finish that order, or release it with cancel_cart on the cart page, before previewing another.");

    // 1. Seat page. AMC redirects /showtimes/<id> to /seats for reserved seating and to /tickets otherwise.
    await gotoUrl(`${ORIGIN}/showtimes/${id}`);
    let at = null;
    for (let i = 0; i < 40; i++) {
      await waitMs(250);
      const p = await page().catch(() => null);
      if (!p) continue;
      if (challenged(p)) return fail("challenge", "AMC's security check (Cloudflare) is showing instead of the seat page; no order was created. Ask the user to complete the check in the browser, or wait, before retrying once. This tool does not bypass the check.");
      if (p.missing) return fail("not_found", `AMC has no page for showtime ${id} (it may be past or never existed).`);
      const m = new RegExp(`^/showtimes/${id}/(seats|tickets)$`).exec(p.path);
      if (m && p.ready !== "loading") {
        const ready = await js(step => step === "seats"
          ? [...document.querySelectorAll('[role="grid"][aria-label="Seat Selection Map"] input')].some(i => Object.keys(i).some(k => k.startsWith("__reactProps")))
          : [...document.querySelectorAll('button[aria-label^="Add "][aria-label$=" Ticket"]')].some(b => Object.keys(b).some(k => k.startsWith("__reactProps"))), { arg: m[1] });
        if (ready) { at = m[1]; break; }
      }
    }
    if (!at) {
      const p = await page();
      return /^\/showtimes\//.test(p.path) ? fail("not_ready", "AMC's seat or ticket page did not finish loading.") : fail("not_found", `AMC did not open a ticket flow for showtime ${id} (it may be past, sold out or not sold online).`);
    }
    if (at === "tickets") return fail("invalid_input", "This showtime has no reserved seating, so it cannot be priced with seat names.");

    const showtime = (await js(() => {
      const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
      const info = [...document.querySelectorAll("h2")].find(h => text(h) === "Showtime Information");
      const box = info && info.parentElement;
      const li = box ? [...box.querySelectorAll("li")].map(text) : [];
      return { movie: text(box && box.querySelector("h3")) || null, theatre: li[0] || null, date: li[1] || null, time: li[2] || null };
    }).catch(() => null)) || { movie: null, theatre: null, date: null, time: null };
    const chosen = () => js(() => (new URLSearchParams(location.search).get("seats") || "").split(",").filter(Boolean));
    // AMC sometimes re-renders the seat page just after the first picks, clearing them and replacing the Continue link, so picking and that Continue are retried.
    let continued = false;
    for (let attempt = 0; attempt < 3 && !continued; attempt++) {
      const have = await chosen().catch(() => []);
      const picked = await js(({ seats, accessible, have }) => {
        const grid = document.querySelector('[role="grid"][aria-label="Seat Selection Map"]');
        for (const name of seats) {
          const box = grid && grid.querySelector(`input[name="${name}"]`);
          if (!box) return { problem: "not_found", seat: name };
          if (have.includes(name)) continue;
          const label = box.getAttribute("aria-label") || "";
          if (box.disabled || /^Occupied /.test(label)) return { problem: "taken", seat: name };
          if (!accessible && /wheelchair|companion/i.test(label)) return { problem: "accessible", seat: name };
          if (box.checked || /^Selected /.test(label)) return { problem: "already", seat: name };
          box.closest("label").setAttribute("data-xwebmcp-seat", name);
        }
        return { problem: null };
      }, { arg: { seats, accessible: input.accessible_seating === true, have } }).catch(() => null);
      if (!picked) return fail("not_ready", "The seat page changed while it was being read.");
      if (picked.problem === "not_found") return fail("seat_unavailable", `Seat ${picked.seat} is not on this showtime's seat map.`);
      if (picked.problem === "taken") return fail("seat_unavailable", `Seat ${picked.seat} is already taken. Check get_seat_map for open seats.`);
      if (picked.problem === "accessible") return fail("seat_unavailable", `Seat ${picked.seat} is a wheelchair space or companion seat; pass accessible_seating: true only for a guest who needs it.`);
      if (picked.problem === "already") return fail("not_ready", `Seat ${picked.seat} is already selected on the page; retry.`);
      for (const name of seats.filter(s => !have.includes(s))) {
        const clicked = await click(`label[data-xwebmcp-seat="${name}"]`, { timeoutSec: 5 }).then(() => true, () => false);
        let ok = false;
        for (let i = 0; i < 20 && clicked && !ok; i++) { await waitMs(150); ok = (await chosen()).includes(name); }
        if (!ok) break;
      }
      if ((await chosen()).sort().join() !== [...seats].sort().join()) continue;
      const next = await js(seats => {
        const a = [...document.querySelectorAll("a")].filter(a => a.textContent.trim() === "Continue" && /\/tickets\?/.test(a.getAttribute("href") || ""));
        if (a.length !== 1 || (new URLSearchParams(a[0].getAttribute("href").split("?")[1]).get("seats") || "").split(",").sort().join() !== [...seats].sort().join()) return false;
        a[0].setAttribute("data-xwebmcp-next", "seats");
        return true;
      }, { arg: seats }).catch(() => false);
      // A click can fail after it lands, when the ticket page replaces this one mid-press.
      if (next) continued = await click('a[data-xwebmcp-next="seats"]', { timeoutSec: 5 }).then(() => true, () => js(id => location.pathname === `/showtimes/${id}/tickets`, { arg: id }).catch(() => false));
    }
    if (!continued) return fail("site_error", "AMC's seat page did not keep the selected seats and show their Continue link after 3 tries.");

    // 2. Ticket page: choosing types only changes the page; nothing is sent until its Continue, which this tool never presses.
    let rows = null;
    for (let i = 0; i < 40 && !rows; i++) {
      await waitMs(250);
      rows = await js(id => {
        if (location.pathname !== `/showtimes/${id}/tickets`) return null;
        const out = [];
        for (const add of document.querySelectorAll('button[aria-label^="Add "][aria-label$=" Ticket"]')) {
          if (!Object.keys(add).some(k => k.startsWith("__reactProps"))) return null;
          const type = add.getAttribute("aria-label").slice(4, -7);
          add.setAttribute("data-xwebmcp-add", type.toLowerCase());
          const row = add.closest('[role="row"]');
          // The quantity cell reads, for example, "2 Adult selected".
          const count = row && [...row.querySelectorAll("span")].map(s => /^(\d+) .*selected$/.exec(s.textContent.replace(/\s+/g, " ").trim())).find(Boolean);
          out.push({ type, count: count ? Number(count[1]) : null });
        }
        return out.length ? out : null;
      }, { arg: id }).catch(() => null);
    }
    if (!rows) return fail("not_ready", "AMC's ticket page did not finish loading.");
    const offered = rows.map(r => r.type);
    for (const t of tickets) {
      if (!rows.some(r => r.type.toLowerCase() === t.type.trim().toLowerCase())) return fail("invalid_ticket_type", `AMC does not offer "${t.type}" tickets for this showtime.`, { available: offered.slice(0, 20) });
    }
    if (rows.some(r => r.count !== 0)) return fail("not_ready", "AMC's ticket page already had tickets selected; retry.");
    // Ticket types come from the page, so buttons are addressed by the marker set above, never by building a selector from that text.
    const counts = () => js(() => Object.fromEntries([...document.querySelectorAll("button[data-xwebmcp-add]")].map(add => {
      const row = add.closest('[role="row"]');
      const c = row && [...row.querySelectorAll("span")].map(s => /^(\d+) .*selected$/.exec(s.textContent.replace(/\s+/g, " ").trim())).find(Boolean);
      return [add.getAttribute("data-xwebmcp-add"), c ? Number(c[1]) : null];
    })));
    const wanted = Object.fromEntries(rows.map(r => [r.type.toLowerCase(), 0]));
    for (const t of tickets) {
      const key = t.type.trim().toLowerCase();
      for (let n = 1; n <= t.quantity; n++) {
        if (canceled()) return canceled();
        await click(`button[data-xwebmcp-add="${key.replace(/["\\]/g, "\\$&")}"]`);
        let ok = false;
        for (let i = 0; i < 20 && !ok; i++) { await waitMs(100); ok = (await counts())[key] === n; }
        if (!ok) return fail("site_error", `AMC did not accept ${t.type} ticket ${n} of ${t.quantity}.`);
      }
      wanted[key] = t.quantity;
    }
    const final = await counts();
    if (Object.keys(wanted).some(k => final[k] !== wanted[k])) return fail("site_error", "AMC's ticket counts differ from the request.");
    const seatsNow = await js(() => (new URLSearchParams(location.search).get("seats") || "").split(",").filter(Boolean).sort().join());
    if (seatsNow !== [...seats].sort().join()) return fail("site_error", "AMC's ticket page lists different seats than requested, so its prices may not apply to them.");

    // 3. Read the prices of the chosen rows, as get_ticket_prices does.
    const prices = await js(() => {
      const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
      const usd = t => { const m = /^\$(\d{1,4}(?:,\d{3})*\.\d{2})$/.exec(t || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
      const grid = document.querySelector('[role="grid"][aria-label="Ticket Selection"]');
      if (!grid) return null;
      const out = {};
      for (const row of grid.querySelectorAll('[role="row"]')) {
        const add = row.querySelector("button[data-xwebmcp-add]");
        const cell = row.querySelector('[role="gridcell"]');
        if (!add || !cell) continue;
        const breakdown = cell.querySelector('[aria-label="Price Breakdown"]');
        const parts = /^(\$[\d,.]+) \+ (\$[\d,.]+) Fee\*?$/.exec(text(breakdown));
        out[add.getAttribute("data-xwebmcp-add")] = { name: text(row.querySelector('[role="rowheader"] p')), with_fees: usd(text(cell).replace(text(breakdown), "").trim()), price: parts ? usd(parts[1]) : null, fee: parts ? usd(parts[2]) : null };
      }
      const form = grid.closest("form");
      const notice = form && form.parentElement ? text(form.parentElement.querySelector("p")) : "";
      return { rows: out, notice: notice && notice !== text(form.querySelector("p")) && notice.length <= 300 ? notice : null };
    }).catch(() => null);
    if (!prices) return fail("not_ready", "AMC's ticket page shows no ticket prices yet.");
    const lines = [];
    for (const t of tickets) {
      const row = prices.rows[t.type.trim().toLowerCase()];
      if (!row || row.with_fees === null) return fail("site_error", `AMC's ticket page shows no price for ${t.type} tickets.`);
      lines.push({ ticket_type: row.name || t.type.trim(), quantity: t.quantity, price_with_fees: row.with_fees, price: row.price, convenience_fee: row.fee, line_total: Math.round(row.with_fees * t.quantity * 100) / 100 });
    }
    const subtotal = Math.round(lines.reduce((sum, l) => sum + l.line_total, 0) * 100) / 100;
    return {
      status: "ok",
      showtime_id: id,
      showtime,
      seats: [...seats],
      lines,
      currency: "USD",
      expected_subtotal: subtotal,
      notice: prices.notice,
      continue_pressed: false,
      next_step: `Show the user the seats, lines and subtotal ($${subtotal.toFixed(2)} before taxes; AMC can still apply a discount in the cart, which add_tickets_to_cart returns). Nothing is held. Only if they want these seats held, call add_tickets_to_cart with the same showtime_id, seats and tickets and expected_subtotal: ${subtotal}.`,
      observed_at: new Date().toISOString()
    };
  }
}]
