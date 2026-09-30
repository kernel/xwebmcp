[{
  kind: "page",
  match: { url_patterns: ["https://www.ticketmaster.com/*"] },
  tool: {
    name: "prepare_ticket_choice",
    description: "Prepare one ticket choice on the current classic Ticketmaster US event page, without selecting seats, changing filters, accepting terms, entering a queue or holding inventory. First open the event yourself; event must match the current document. Re-reads the public quick-picks request that this page already made, for your quantity, in lowest-price order. Picks the lowest-priced matching offer among at most 40 sampled listings within max_total_before_tax; optional section, row and ticket_type are exact text matches (case-insensitive). Only public, unprotected USD offers with explicit sellable quantity are supported. Returns the observed seat/type choice, per-ticket price including fees before taxes, reported taxes, and estimated totals. This is not a final checkout quote, availability guarantee, approval, cart or reservation. All event terms, per-order fees and final tax/cost must be reviewed manually; no execution tool follows automatically. Runs page-local with current browser credentials, never navigates or submits anything. Use get_ticket_offers for broader browsing; a prepared choice may disappear before a human acts.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["event", "quantity", "max_total_before_tax"],
      properties: {
        event: { type: "string", minLength: 6, maxLength: 400, description: "Event id, or a HTTPS www.ticketmaster.com/event/<id> URL. Must match the current event page." },
        quantity: { type: "integer", minimum: 1, maximum: 8 },
        max_total_before_tax: { type: "number", exclusiveMinimum: 0, maximum: 800000, description: "Budget for all requested tickets including reported ticket fees, before taxes and any per-order fee, in USD." },
        section: { type: "string", minLength: 1, maxLength: 80 },
        row: { type: "string", minLength: 1, maxLength: 80 },
        ticket_type: { type: "string", minLength: 1, maxLength: 150 },
        inventory_type: { enum: ["any", "primary", "resale"], default: "any" }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "event_id", "event_url", "quantity", "max_total_before_tax", "observed_at", "sampled_listings", "site_total_listings", "price_basis", "currency", "choice", "inventory_held", "execution_supported", "execution_blocker", "warnings"],
          properties: {
            status: { const: "prepared" }, event_id: { type: "string", maxLength: 40 }, event_url: { type: "string", format: "uri", maxLength: 100 },
            quantity: { type: "integer", minimum: 1, maximum: 8 }, max_total_before_tax: { type: "number" }, observed_at: { type: "string" },
            sampled_listings: { type: "integer", minimum: 0, maximum: 40 }, site_total_listings: { type: ["integer", "null"], minimum: 0 },
            price_basis: { const: "per ticket, including reported fees, before taxes; totals exclude unreported per-order fees" }, currency: { const: "USD" },
            choice: {
              type: "object", additionalProperties: false,
              required: ["section", "row", "seats", "general_admission", "ticket_type", "inventory_type", "price_per_ticket_before_tax", "reported_fees_per_ticket", "reported_taxes_per_ticket", "estimated_total_before_tax", "estimated_total_with_reported_taxes"],
              properties: {
                section: { type: ["string", "null"], maxLength: 80 }, row: { type: ["string", "null"], maxLength: 80 },
                seats: { type: "array", maxItems: 8, items: { type: "string", maxLength: 30 } }, general_admission: { type: "boolean" },
                ticket_type: { type: "string", minLength: 1, maxLength: 150 }, inventory_type: { enum: ["primary", "resale"] },
                price_per_ticket_before_tax: { type: "number", minimum: 0 }, reported_fees_per_ticket: { type: "number", minimum: 0 }, reported_taxes_per_ticket: { type: "number", minimum: 0 },
                estimated_total_before_tax: { type: "number", minimum: 0 }, estimated_total_with_reported_taxes: { type: "number", minimum: 0 }
              }
            },
            inventory_held: { const: false }, execution_supported: { const: false }, execution_blocker: { type: "string", maxLength: 400 },
            warnings: { type: "array", maxItems: 5, items: { type: "string", maxLength: 400 } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "queue", "challenge", "rate_limit", "login_required", "cancelled", "unsupported_page", "site_changed", "no_matching_offer", "site_error"] },
            error_message: { type: "string", minLength: 1, maxLength: 500 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const ORIGIN = "https://www.ticketmaster.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["event", "quantity", "max_total_before_tax", "section", "row", "ticket_type", "inventory_type"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Provide only event, quantity, max_total_before_tax and optional section, row, ticket_type, inventory_type. No approval or execution inputs are accepted.");
    let id = typeof input.event === "string" ? input.event.trim() : "";
    if (id.length > 400) return fail("invalid_input", "event is too long.");
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) {
      let url;
      try { url = new URL(id); } catch { return fail("invalid_input", "event must be an event id or a Ticketmaster event URL."); }
      if (url.protocol !== "https:" || !["www.ticketmaster.com", "ticketmaster.com"].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return fail("invalid_input", "Use a clean HTTPS Ticketmaster US event URL without credentials, port, query or fragment.");
      id = /\/event\/([A-Za-z0-9_-]{6,40})\/?$/.exec(url.pathname)?.[1] || "";
      if (!id) return fail("invalid_input", "The URL must end in /event/<id>.");
    }
    const qty = input.quantity;
    const budget = input.max_total_before_tax;
    if (!Number.isInteger(qty) || qty < 1 || qty > 8 || typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0 || budget > 800000) return fail("invalid_input", "quantity must be 1–8 and max_total_before_tax a positive USD amount up to 800000.");
    for (const [key, max] of [["section", 80], ["row", 80], ["ticket_type", 150]]) {
      if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim() || input[key].length > max || /[<>\x00-\x1f\x7f]/.test(input[key]))) return fail("invalid_input", key + " must be nonempty plain text up to " + max + " characters.");
    }
    const inventory = input.inventory_type === undefined ? "any" : input.inventory_type;
    if (!["any", "primary", "resale"].includes(inventory)) return fail("invalid_input", "inventory_type must be any, primary or resale.");
    if (context.signal?.aborted) return fail("cancelled", "Preparation was cancelled; no request was made.");
    const text = (v, max) => typeof v === "string" && v.trim() && v.length <= max && !/[<>\x00-\x1f\x7f]/.test(v) ? v.trim() : null;
    const same = (value, criterion) => criterion === undefined || (value !== null && value.toLowerCase() === criterion.trim().toLowerCase());
    const cents = v => Math.round(v * 100);
    try {
      if (/queue/i.test(window.location.hostname + window.location.pathname)) return fail("queue", "This document is a waiting room; preparation never enrolls in or advances a queue.");
      if (window.location.origin !== ORIGIN || /\/event\/([A-Za-z0-9_-]{6,40})\/?$/.exec(window.location.pathname)?.[1] !== id) return fail("wrong_page", "Open https://www.ticketmaster.com/event/" + id + " manually first. This tool never navigates.");
      if (/browsing activity has been paused|pardon (the|our) interruption|access denied|verify.*human|just a moment|are you a robot/i.test(document.title || "")) return fail("challenge", "Ticketmaster is showing a protection page; stop and wait. No ticket choice was made.");
      if (/waiting room|you are in.*queue|your place in.*queue/i.test(document.body?.innerText || "")) return fail("queue", "The event page is showing a waiting room; preparation never enters or advances it.");
      let data;
      try { data = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "null"); } catch { return fail("site_changed", "The event page metadata was not readable."); }
      if (data?.page !== "/naevent/[eventId]") return fail("unsupported_page", "Only the classic public-offer event layout is supported. The newer layout would require changing a remembered quantity preference; preparation does not do that.");
      const path = "/api/ismds/event/" + id + "/quickpicks";
      const requests = performance.getEntriesByType("resource").map(e => {
        try { return new URL(e.name); } catch { return null; }
      }).filter(u => u && ["https://services.ticketmaster.com", "https://offeradapter.ticketmaster.com"].includes(u.origin) && u.pathname === path && !u.username && !u.password && !u.hash);
      const request = requests.find(u => u.searchParams.has("promoted")) || requests[0];
      if (!request) return fail("site_changed", "No supported public quick-picks request was observed on this document. No guessed endpoint or checkout request was used.");
      for (const [key, value] of Object.entries({ qty: String(qty), sort: "noTaxTotalprice", limit: "40", offset: "0", includeResale: String(inventory !== "primary") })) request.searchParams.set(key, value);
      // Preserve the observed query's accessibility and ticket-type restrictions, rather than unlocking inventory.
      const response = await new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        const cancel = () => { xhr.abort(); resolve({ cancelled: true }); };
        const finish = value => { context.signal?.removeEventListener("abort", cancel); resolve(value); };
        xhr.open("GET", request.href);
        xhr.withCredentials = true;
        xhr.setRequestHeader("TMPS-Correlation-Id", crypto.randomUUID());
        xhr.timeout = 20000;
        xhr.onload = () => {
          let body = null;
          try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
          finish({ status: xhr.status, body });
        };
        xhr.onerror = () => finish({ status: 0, body: null });
        xhr.ontimeout = () => finish({ status: 0, body: null });
        context.signal?.addEventListener("abort", cancel, { once: true });
        if (context.signal?.aborted) return cancel();
        xhr.send();
      });
      if (response.cancelled || context.signal?.aborted) return fail("cancelled", "Preparation was cancelled. No inventory was held and nothing was submitted.");
      if (response.status === 429) return fail("rate_limit", "Ticketmaster rate-limited the quote request. Stop; no automatic retry was made.");
      if (response.status === 401) return fail("login_required", "The public offer request requires sign-in; this tool does not log in or unlock inventory.");
      if (response.status === 403) return fail("challenge", "Ticketmaster refused the quote request. Stop; no bypass or automatic retry was made.");
      if (response.status !== 200) return fail("site_error", "The quote request failed (HTTP " + response.status + "). No retry was made.");
      const b = response.body;
      if (!b || !Array.isArray(b.picks) || !Array.isArray(b._embedded?.offer) || b.picks.length > 40) return fail("site_changed", "The public offer response did not have the expected bounded listings and price records.");
      const offers = new Map(b._embedded.offer.map(o => [o?.offerId, o]));
      const choices = [];
      let incomplete = false;
      for (const p of b.picks) {
        const section = text(p?.section, 80), row = text(p?.row, 80);
        if (!same(section, input.section) || !same(row, input.row)) continue;
        if (!Array.isArray(p?.offerGroups)) { incomplete = true; continue; }
        for (const group of p.offerGroups) {
          if (!Array.isArray(group?.offers)) { incomplete = true; continue; }
          for (const offerId of group.offers) {
            const o = offers.get(offerId);
            if (!o || o.protected !== false || o.online !== true || o.currency !== "USD" || !["primary", "resale"].includes(o.inventoryType) || (inventory !== "any" && o.inventoryType !== inventory)) continue;
            const type = text(o.name, 150);
            if (!type || !same(type, input.ticket_type)) continue;
            if (!Array.isArray(o.sellableQuantities)) { incomplete = true; continue; }
            if (!o.sellableQuantities.includes(qty)) continue;
            if (!Number.isFinite(o.totalPrice) || o.totalPrice < 0 || o.totalPrice > 100000 || !Array.isArray(o.charges) || o.charges.some(c => !["tax", "fee"].includes(c?.type) || !Number.isFinite(c.amount) || c.amount < 0 || c.amount > 100000)) { incomplete = true; continue; }
            const taxes = o.charges.filter(c => c.type === "tax").reduce((a, c) => a + cents(c.amount), 0);
            const fees = o.charges.filter(c => c.type === "fee").reduce((a, c) => a + cents(c.amount), 0);
            const price = cents(o.totalPrice) - taxes;
            if (price < fees || price < 0) { incomplete = true; continue; }
            if (price * qty / 100 > budget) continue;
            const ga = p.type === "general-seating";
            const seats = Array.isArray(group.seats) ? group.seats.map(s => text(typeof s === "number" ? String(s) : s, 30)) : null;
            if ((!ga && (!seats || seats.length !== qty || seats.some(s => !s) || new Set(seats).size !== qty)) || (ga && seats?.length)) { incomplete = true; continue; }
            choices.push({ section, row, seats: seats || [], general_admission: ga, ticket_type: type, inventory_type: o.inventoryType,
              price_per_ticket_before_tax: price / 100, reported_fees_per_ticket: fees / 100, reported_taxes_per_ticket: taxes / 100,
              estimated_total_before_tax: price * qty / 100, estimated_total_with_reported_taxes: (price + taxes) * qty / 100 });
          }
        }
      }
      choices.sort((a, c) => a.estimated_total_before_tax - c.estimated_total_before_tax);
      if (!choices.length) return fail(incomplete ? "site_changed" : "no_matching_offer", incomplete ? "Some sampled listings lacked usable prices or quantity/seat evidence; no trustworthy matching choice could be prepared." : "No matching public USD offer in the first " + b.picks.length + " sampled listings. This does not prove the event is sold out; protected and other inventory may exist.");
      const warnings = ["Quotes may change immediately; this choice is not selected, reserved or guaranteed. Review event terms and final checkout total manually.", "Only up to 40 listings in the observed page query were sampled; this is not a complete inventory search or guaranteed event-wide lowest price.", "Reported tax is informational. Unreported per-order fees and final taxes are not included in the budget check."];
      if (incomplete) warnings.push("Some sampled listings had incomplete price or quantity evidence and were skipped.");
      return { status: "prepared", event_id: id, event_url: ORIGIN + "/event/" + id, quantity: qty, max_total_before_tax: budget, observed_at: new Date().toISOString(),
        sampled_listings: b.picks.length, site_total_listings: Number.isInteger(b.total) && b.total >= 0 ? b.total : null,
        price_basis: "per ticket, including reported fees, before taxes; totals exclude unreported per-order fees", currency: "USD", choice: choices[0],
        inventory_held: false, execution_supported: false, execution_blocker: "Purchase, transfer and reservation execution are not exposed: this runtime has no supported trusted human approval path bound to the exact account, seats, quantity, final cost, recipient and terms.", warnings };
    } catch {
      return fail("site_error", "The public quote could not be read; no selection, hold, submission or automatic retry occurred.");
    }
  }
}]
