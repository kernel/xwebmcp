[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'get_trip_summary',
    description: 'Read the trip Alaska is pricing: on the results page\'s trip summary, the cart (/search/cart) or any checkout step (/book/...). Returns each flight slice (route and date), each segment\'s flight number, fare and booking class, the price lines (airfare, seats, travel insurance and other extras), the taxes and fees Alaska lists as included, the total, the per-person total on the results summary, the cart hold time left and, on the cart, the fare-rule and change/cancellation notes. Never returns traveler names or account numbers. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['status', 'page', 'slices', 'segments', 'price_lines', 'included_taxes_and_fees', 'total', 'currency', 'message'],
      properties: {
        status: { enum: ['ok', 'wrong_page'] },
        page: { type: ['string', 'null'], enum: ['results_trip_summary', 'cart', 'checkout', null] },
        slices: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'to', 'date'], properties: { from: { type: 'string' }, to: { type: 'string' }, date: { type: ['string', 'null'] } } } },
        segments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['flight', 'fare', 'booking_class'], properties: { flight: { type: 'string' }, fare: { type: ['string', 'null'] }, booking_class: { type: ['string', 'null'] }, operated_by: { type: ['string', 'null'] } } } },
        price_lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'amount'], properties: { label: { type: 'string' }, amount: { type: 'number' } } } },
        included_taxes_and_fees: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'amount'], properties: { label: { type: 'string' }, amount: { type: 'number' } } } },
        total: { type: ['number', 'null'] },
        total_basis: { type: ['string', 'null'], description: 'e.g. "per person, round trip" on the results summary; null means the whole booking.' },
        currency: { type: 'string', const: 'USD' },
        passengers: { type: ['integer', 'null'] },
        session_time_left: { type: ['string', 'null'] },
        fare_notes: { type: 'array', items: { type: 'string' } },
        message: { type: ['string', 'null'] }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    const path = location.pathname;
    const main = text(document.querySelector('main') || document.body);
    const base = { status: 'wrong_page', page: null, slices: [], segments: [], price_lines: [], included_taxes_and_fees: [], total: null, total_basis: null, currency: 'USD', passengers: null, session_time_left: null, fare_notes: [], message: null };
    let page = null;
    if (/^\/search\/results/.test(path) && /Trip summary Clear all selections/.test(main)) page = 'results_trip_summary';
    else if (/^\/search\/cart/.test(path)) page = 'cart';
    else if (/^\/book\/(guest-info|seat-selection|checkout)/.test(path)) page = 'checkout';
    if (location.hostname !== 'www.alaskaair.com' || !page) return { ...base, message: 'No Alaska trip summary on this page: choose flights first (the results page shows a trip summary once all flights are chosen) or open the cart.' };
    const money = (s) => Number(String(s).replace(/[$,]/g, ''));
    const slices = [];
    const sliceRe = /([A-Z][A-Za-z.' -]*(?:, [A-Z]{2})?) \(([A-Z]{3})\) to ([A-Z][A-Za-z.' -]*(?:, [A-Z]{2})?) \(([A-Z]{3})\)(?: (?:\d+h \d+m \d[\d,]* miles )?((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,? [A-Z][a-z]+ \d{1,2}))?/g;
    const seenSlices = new Set();
    for (const m of main.matchAll(sliceRe)) { const k = m[2] + m[4]; if (seenSlices.has(k)) continue; seenSlices.add(k); slices.push({ from: m[2], to: m[4], date: m[5] || null }); }
    // Checkout steps write the date before the route ("Departing Tuesday, November 10 Seattle (SEA) to ...").
    if (slices.length && slices.every((s) => !s.date)) {
      const dates = [...main.matchAll(/(?:Departing|Returning|Flight \d) ((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, [A-Z][a-z]+ \d{1,2})/g)].map((m) => m[1]);
      slices.forEach((s, i) => { s.date = dates[i] || null; });
    }
    const segments = [...main.matchAll(/\b([A-Z0-9]{2} \d{1,4}) \| ([A-Za-z ]+?) \(([A-Z])\)(?: \| Operated by ([A-Za-z ]+?)(?= Details| Seats| Returning| Fare| Change| \S+:|$))?/g)].map((m) => ({ flight: m[1], fare: m[2], booking_class: m[3], operated_by: m[4] || null }));
    if (!segments.length) for (const m of main.matchAll(/\b(AS|HA) (\d{1,4}) \d+h \d+m/g)) segments.push({ flight: m[1] + ' ' + m[2], fare: null, booking_class: null, operated_by: null });
    const out = { ...base, status: 'ok', page, slices, segments };
    out.session_time_left = (/Session expires in (\d\d:\d\d:\d\d)/.exec(main) || [])[1] || null;
    if (page === 'results_trip_summary') {
      const m = /Total: \$([\d,]+(?:\.\d\d)?) ([a-z ,-]+?)(?= Add to cart| Inflight|$)/.exec(main);
      out.total = m ? money(m[1]) : null;
      out.total_basis = m ? m[2].trim() : null;
      out.message = 'Results-page summary: Alaska shows the per-person total only; continue_checkout ("Add to cart") prices the whole booking.';
      return out;
    }
    const i = main.lastIndexOf('Price summary');
    const block = i >= 0 ? main.slice(i + 'Price summary'.length) : '';
    const totalM = /Total(?: price)? \$([\d,]+\.\d\d)/.exec(block);
    out.total = totalM ? money(totalM[1]) : null;
    const body = totalM ? block.slice(0, totalM.index) : block;
    const clean = body.replace(/View included taxes, fees, and charges|Standard fare, taxes, fees and charges|Currency converter|Free cancellation within 24 hrs of purchase|United States|Passengers x\d+/g, ' ');
    for (const m of clean.matchAll(/([A-Za-z][A-Za-z0-9 .,'&()/-]*?)\s+(-?)\$([\d,]+\.\d\d)/g)) {
      const label = m[1].replace(/\s+/g, ' ').trim();
      const amount = (m[2] ? -1 : 1) * money(m[3]);
      if (/\b(tax|fee|charge)s?\b/i.test(label) && !/insurance|seat|bag/i.test(label)) out.included_taxes_and_fees.push({ label, amount });
      else out.price_lines.push({ label, amount });
    }
    const px = /Passengers x(\d+)/.exec(block) || /(\d+) Travell?ers?\b/.exec(text(document.querySelector('header, borealis-header')) || '');
    out.passengers = px ? Number(px[1]) : null;
    if (page === 'cart') {
      for (const [head, end] of [['Fare rules ', ' View all fare rules'], ['Change and cancellation policy ', ' Baggage policy']]) {
        const k = main.indexOf(head);
        if (k < 0) continue;
        const e = main.indexOf(end, k);
        out.fare_notes.push(main.slice(k, e > k ? e : k + 700).slice(0, 900));
      }
    }
    if (out.total === null) out.message = 'Price summary not found yet; call get_page_context with wait_for_settled_seconds and try again.';
    return out;
  }
}]
