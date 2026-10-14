[{
  kind: "cdp",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "add_tickets_to_cart",
    title: "Put AMC tickets in a cart",
    description: "Put tickets for one AMC showtime in a cart, the way a person does on AMC's site: open the showtime's seat page, pick the given seats, choose ticket types and counts, and press Continue, which makes AMC create the order and open its cart page. Returns the cart's ticket lines, seats, fees, taxes, total and how long AMC holds it, as the cart page shows them, plus the movie, theatre, date and time from the seat page. The cart HOLDS the seats against other buyers until AMC's timer runs out (about 7 minutes) or cancel_cart releases them; only create one when the user wants these seats. It never adds food, applies rewards or promo codes, opens checkout or pays: the user finishes the purchase in the same tab, or the cart expires. Use showtime_id from get_showtimes and seat names from get_seat_map (for example F7); the ticket counts must add up to the number of seats. Call preview_tickets first and show the user its price: it makes the same choices without creating an order. Its expected_subtotal is required here, and this tool refuses, before Continue, if the ticket page now prices the tickets differently. If AMC's cart lists other seats than requested, it returns cart_mismatch: the cart holds those seats, so release it with cancel_cart. Wheelchair spaces and companion seats are refused unless accessible_seating is true, because AMC reserves them for guests who need them. Refuses while this tab shows a cart or one of its edit pages; it cannot see carts open in other tabs. AMC's security service (Cloudflare) rate-limits the ticket flow after several carts in a few minutes, so create one cart at a time. A refusal comes back after one press, with no retry, as rate_limited or challenge, or as site_error while the seat page still loads; the limit can last an hour or more, so do not retry until the user has completed AMC's security check in the browser or chosen to wait. If AMC shows an error instead of the cart, it presses nothing more and reports it; AMC releases any order it may have started when the timer runs out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["showtime_id", "seats", "tickets", "expected_subtotal"],
      properties: {
        showtime_id: { type: ["integer", "string"], minimum: 1, maximum: 2147483647, pattern: "^[1-9][0-9]{0,9}$", description: "From get_showtimes; a number or its digits as a string." },
        seats: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", pattern: "^[A-Z]{1,3}[0-9]{1,3}$" }, description: "Seat names as AMC shows them, for example [\"F7\", \"F8\"]." },
        tickets: {
          type: "array", minItems: 1, maxItems: 6,
          items: {
            type: "object", additionalProperties: false, required: ["type", "quantity"],
            properties: { type: { type: "string", minLength: 1, maxLength: 40, description: "Ticket type as AMC lists it for the showtime, for example Adult, Child or Senior (see get_ticket_prices)." }, quantity: { type: "integer", minimum: 1, maximum: 10 } }
          }
        },
        accessible_seating: { type: "boolean", default: false, description: "Allow wheelchair spaces and companion seats, for a guest who needs them." },
        expected_subtotal: { type: "number", minimum: 0, maximum: 100000, description: "preview_tickets' expected_subtotal (USD with fees, before taxes) for the same seats and tickets." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "showtime_id", "cart", "observed_at"],
          properties: {
            status: { const: "added" },
            showtime_id: { type: "integer" },
            cart: {
              type: "object", additionalProperties: false, required: ["movie", "theatre", "date", "time", "lines", "seats", "total", "expires_in_seconds"],
              properties: {
                movie: { type: ["string", "null"] }, theatre: { type: ["string", "null"] }, date: { type: ["string", "null"] }, time: { type: ["string", "null"] },
                lines: {
                  type: "array", maxItems: 30,
                  items: { type: "object", additionalProperties: false, required: ["section", "name", "amount"], properties: { section: { type: "string", description: "Tickets, Fees, Food & Drinks or Order Taxes." }, name: { type: "string" }, amount: { type: ["number", "null"], description: "USD as shown." } } }
                },
                seats: { type: "array", maxItems: 10, items: { type: "string" } },
                total: { type: ["number", "null"], description: "USD as shown; checkout can still add or change charges." },
                expires_in_seconds: { type: ["integer", "null"], description: "Time left on AMC's hold when read." }
              }
            },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "cart_in_progress", "not_found", "seat_unavailable", "invalid_ticket_type", "price_changed", "not_ready", "challenge", "rate_limited", "site_error", "canceled", "outcome_unknown", "cart_mismatch"] },
            error_message: { type: "string" },
            available: { type: "array", maxItems: 20, items: { type: "string" }, description: "For invalid_ticket_type, the ticket types AMC offers." },
            subtotal: { type: ["number", "null"], description: "For price_changed, the subtotal the ticket page shows now." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, ...extra });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["showtime_id", "seats", "tickets", "accessible_seating", "expected_subtotal"].includes(k))) return fail("invalid_input", "Provide showtime_id, seats, tickets and expected_subtotal, and optionally accessible_seating.");
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
    const expected = input.expected_subtotal;
    if (typeof expected !== "number" || !Number.isFinite(expected) || expected < 0 || expected > 100000) return fail("invalid_input", "expected_subtotal must be preview_tickets' expected_subtotal in USD; call preview_tickets with the same showtime_id, seats and tickets and show the user its price first.");
    const canceled = () => context?.signal?.aborted ? fail("canceled", "The call was canceled before Continue was pressed; nothing was held.") : null;
    if (canceled()) return canceled();

    const page = () => js(() => ({ origin: location.origin, path: location.pathname, search: location.search, title: document.title, ready: document.readyState, missing: [...document.querySelectorAll("h1, h2")].some(h => h.textContent.trim() === "Error 404") }));
    const challenged = p => /just a moment|attention required|access denied/i.test(p.title || "");
    const start = await page();
    if (start.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.amctheatres.com page first.");
    // The cart's Edit Tickets link reopens the ticket flow with ?order-token=, so that page belongs to an open cart too.
    // AMC's 404 page in place of an order (it expired or was released) holds nothing.
    if (!start.missing && (/^\/orders\//.test(start.path) || /[?&]order-token=/.test(start.search || ""))) return fail("cart_in_progress", "The tab shows an AMC cart, or a ticket page opened from a cart's Edit link. Finish that order, or release it with cancel_cart on the cart page, before creating another; AMC can release the order itself when Edit is pressed.");

    // 1. Seat page. AMC redirects /showtimes/<id> to /seats for reserved seating and to /tickets otherwise.
    await gotoUrl(`${ORIGIN}/showtimes/${id}`);
    let at = null;
    for (let i = 0; i < 40; i++) {
      await waitMs(250);
      const p = await page().catch(() => null);
      if (!p) continue;
      if (challenged(p)) return fail("challenge", "AMC's security check (Cloudflare) is showing instead of the seat page; nothing was held. It follows several carts in a few minutes and can last an hour or more. Ask the user to complete the check in the browser, or wait, before retrying once. This tool does not bypass the check.");
      if (p.missing) return fail("not_found", `AMC has no page for showtime ${id} (it may be past or never existed); nothing was held.`);
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
      return /^\/showtimes\//.test(p.path) ? fail("not_ready", "AMC's seat or ticket page did not finish loading; nothing was held.") : fail("not_found", `AMC did not open a ticket flow for showtime ${id} (it may be past, sold out or not sold online); nothing was held.`);
    }
    if (at === "tickets") return fail("invalid_input", "This showtime has no reserved seating, so it cannot be bought with seat names; nothing was held.");

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
      if (!picked) return fail("not_ready", "The seat page changed while it was being read; nothing was held.");
      if (picked.problem === "not_found") return fail("seat_unavailable", `Seat ${picked.seat} is not on this showtime's seat map; nothing was held.`);
      if (picked.problem === "taken") return fail("seat_unavailable", `Seat ${picked.seat} is already taken; nothing was held. Check get_seat_map for open seats.`);
      if (picked.problem === "accessible") return fail("seat_unavailable", `Seat ${picked.seat} is a wheelchair space or companion seat; pass accessible_seating: true only for a guest who needs it. Nothing was held.`);
      if (picked.problem === "already") return fail("not_ready", `Seat ${picked.seat} is already selected on the page; reload the showtime and retry. Nothing was held.`);
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
    if (!continued) return fail("site_error", "AMC's seat page did not keep the selected seats and show their Continue link after 3 tries; nothing was held.");

    // 2. Ticket page: choosing types only changes the page; nothing is sent yet.
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
    if (!rows) return fail("not_ready", "AMC's ticket page did not finish loading; nothing was held.");
    const offered = rows.map(r => r.type);
    for (const t of tickets) {
      const row = rows.find(r => r.type.toLowerCase() === t.type.trim().toLowerCase());
      if (!row) return fail("invalid_ticket_type", `AMC does not offer "${t.type}" tickets for this showtime; nothing was held.`, { available: offered.slice(0, 20) });
    }
    if (rows.some(r => r.count !== 0)) return fail("not_ready", "AMC's ticket page already had tickets selected; reload the showtime and retry. Nothing was held.");
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
        await click(`button[data-xwebmcp-add="${key.replace(/["\\]/g, "\\$&")}"]`);
        let ok = false;
        for (let i = 0; i < 20 && !ok; i++) { await waitMs(100); ok = (await counts())[key] === n; }
        if (!ok) return fail("site_error", `AMC did not accept ${t.type} ticket ${n} of ${t.quantity}; nothing was held.`);
      }
      wanted[key] = t.quantity;
    }
    // Re-check the whole order immediately before the only consequential press.
    const final = await counts();
    const seatsNow = await js(() => (new URLSearchParams(location.search).get("seats") || "").split(",").filter(Boolean).sort().join());
    if (Object.keys(wanted).some(k => final[k] !== wanted[k])) return fail("site_error", "AMC's ticket counts differ from the request; Continue was not pressed and nothing was held.");
    if (seatsNow !== [...seats].sort().join()) return fail("site_error", "AMC's ticket page lists different seats than requested; Continue was not pressed and nothing was held.");
    // Same reading as preview_tickets: each chosen type's price with fees, times its count.
    const priced = await js(() => {
      const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
      const usd = t => { const m = /^\$(\d{1,4}(?:,\d{3})*\.\d{2})$/.exec(t || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
      const out = {};
      for (const add of document.querySelectorAll("button[data-xwebmcp-add]")) {
        const cell = add.closest('[role="row"]')?.querySelector('[role="gridcell"]');
        const breakdown = cell && cell.querySelector('[aria-label="Price Breakdown"]');
        out[add.getAttribute("data-xwebmcp-add")] = cell ? usd(text(cell).replace(text(breakdown), "").trim()) : null;
      }
      return out;
    }).catch(() => null);
    const lines = tickets.map(t => priced && priced[t.type.trim().toLowerCase()]);
    if (lines.some(p => typeof p !== "number")) return fail("not_ready", "AMC's ticket page shows no price for a chosen ticket type; Continue was not pressed and nothing was held.");
    const subtotal = Math.round(tickets.reduce((sum, t, i) => sum + Math.round(lines[i] * t.quantity * 100) / 100, 0) * 100) / 100;
    if (Math.abs(subtotal - expected) > 0.005) return fail("price_changed", `AMC's ticket page now prices these tickets at $${subtotal.toFixed(2)} before taxes, not $${expected.toFixed(2)}. Continue was not pressed and nothing was held; show the user the new price (preview_tickets) before trying again.`, { subtotal });

    // 3. Continue makes AMC create the order (its CartCreateOrder request) and open the cart. Pressed once.
    const armed = await js(() => { const b = [...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "Continue" && !b.disabled); if (b.length !== 1) return false; b[0].setAttribute("data-xwebmcp-next", "tickets"); return true; });
    if (!armed) return fail("site_error", "AMC's ticket page shows no single enabled Continue button; nothing was held.");
    if (canceled()) return canceled();
    await click('button[data-xwebmcp-next="tickets"]');
    let state = null, errorSince = null;
    for (let i = 0; i < 100; i++) {
      await waitMs(250);
      state = await js(() => {
        if (/^\/orders\/[^/]+\//.test(location.pathname)) return { cart: !!document.querySelector('aside[role="region"][aria-label="Order Details"]') };
        // AMC's error dialog: an open <dialog> whose body holds the message in a role="alert" paragraph.
        const alert = [...document.querySelectorAll("dialog[open] [role=\"alert\"]")].find(e => e.getClientRects().length && e.textContent.trim());
        return { error: alert ? alert.textContent.replace(/\s+/g, " ").trim().slice(0, 200) : null };
      }).catch(() => null);
      if (state && state.cart) break;
      // Give a cart that is already on its way a second to arrive before trusting the dialog.
      if (state && state.error) { errorSince = errorSince ?? i; if (i - errorSince >= 4) break; } else errorSince = null;
    }
    if (state && state.error) {
      // AMC's "Failed to fetch" is usually Cloudflare refusing the order request. A read-only request for the seat page
      // tells a rate limit (HTTP 429 or a cf-mitigated challenge) apart from other failures.
      const probe = await js(async path => {
        try { const res = await fetch(path, { credentials: "same-origin" }); return { status: res.status, mitigated: res.headers.get("cf-mitigated") }; } catch { return null; }
      }, { arg: `/showtimes/${id}/seats` }).catch(() => null);
      if (probe && (probe.status === 429 || probe.mitigated)) return fail("rate_limited", `AMC's security service (Cloudflare) refused the order request and is rate-limiting the ticket pages. The tool pressed Continue once and stopped; if AMC started an order anyway it releases the seats when its timer runs out. The limit follows several carts in a few minutes and can last an hour or more: do not retry until the user has completed AMC's security check in the browser or chosen to wait.`);
    }
    if (state && state.error) return fail("site_error", `AMC's page showed "${state.error}" instead of a cart. The tool pressed Continue once and stopped. This is usually AMC's security service limiting order requests after several carts in a few minutes, which can last an hour or more: do not retry until the user has completed AMC's security check in the browser or chosen to wait. If AMC started an order anyway it releases the seats when its timer runs out.`);
    if (!state || !state.cart) return fail("outcome_unknown", "Continue was pressed once but AMC's cart did not appear within 25 seconds. Do not retry blindly: the seats may be held until AMC's timer runs out.");

    // AMC shows the hold timer a moment after the order panel; give it up to 3 seconds.
    for (let waited = 0; waited < 3000; waited += 250) {
      if (await js(() => /\d{1,2}:\d{2} left/.test(document.body.innerText || "")).catch(() => false)) break;
      await waitMs(250);
    }
    // Same reading as get_cart; keep the two in step.
    const cart = await js(() => {
      const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
      const usd = t => { const m = /^(-?)\$(\d{1,6}(?:,\d{3})*\.\d{2})$/.exec(t); return m ? Number(m[2].replace(/,/g, "")) * (m[1] ? -1 : 1) : null; };
      const panels = [...document.querySelectorAll('aside[role="region"][aria-label="Order Details"]')];
      const panel = panels.find(a => a.getClientRects().length) || panels[0];
      const lines = [], seats = [];
      for (const h4 of panel.querySelectorAll("h4")) {
        const list = h4.closest("ul");
        const heading = list && list.parentElement && list.parentElement.querySelector("h2");
        const amount = h4.parentElement && h4.parentElement.parentElement && h4.parentElement.parentElement.children[1];
        if (text(h4)) lines.push({ section: text(heading) || "Order", name: text(h4).slice(0, 200), amount: usd(text(amount)) });
      }
      for (const li of panel.querySelectorAll("li")) { const m = /^Seats? ([A-Z0-9, ]+)$/.exec(text(li)); if (m) seats.push(...m[1].split(/[ ,]+/).filter(Boolean)); }
      const totalLine = [...panel.querySelectorAll("p")].find(p => /^Total/i.test(text(p)));
      const left = /(\d{1,2}):(\d{2}) left/.exec(document.body.innerText || "");
      return { lines: lines.slice(0, 30), seats: [...new Set(seats)].slice(0, 10), total: totalLine ? usd(text(totalLine).replace(/^Total\s*/i, "")) : null, expires_in_seconds: left ? Number(left[1]) * 60 + Number(left[2]) : null };
    }).catch(() => null);
    if (!cart) return fail("outcome_unknown", "AMC opened a cart, which holds the seats, but the tool could not read it. Read it with get_cart, or release it with cancel_cart.");
    if (cart.seats.length && [...cart.seats].sort().join() !== [...seats].sort().join()) return fail("cart_mismatch", `AMC's cart lists seats ${cart.seats.join(", ")}, not the requested ${seats.join(", ")}. The cart holds those seats until AMC's timer runs out: release it with cancel_cart and tell the user.`);
    return { status: "added", showtime_id: id, cart: { ...showtime, ...cart }, observed_at: new Date().toISOString() };
  }
}]
