[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'list_seat_map',
    description: 'Read the seat map Alaska\'s Seats step (/book/seat-selection) shows for the current flight: flight number and aircraft, each seat with its type (first, premium, main_preferred, main, unavailable), position and exit-row flag, the price range Alaska lists per seat type, each traveler\'s current seat and price (by traveler_index, never names), and the seats total and booking total. Saver fares cannot choose standard Main Cabin seats (paid Premium and Main Preferred stay selectable). Returns not_ready while the map is still drawing: call again. Read-only. Exact seat prices appear only once a seat is chosen; select_seat checks them against a maximum.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { include_unavailable: { type: 'boolean', default: false } } },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['status', 'flight', 'seats', 'type_prices', 'travelers', 'seats_total', 'total', 'message'],
      properties: {
        status: { enum: ['ok', 'not_ready', 'wrong_page'] },
        flight: { type: ['string', 'null'] },
        aircraft: { type: ['string', 'null'] },
        seats: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['seat', 'type', 'available'], properties: { seat: { type: 'string' }, type: { type: 'string' }, available: { type: 'boolean' }, position: { type: ['string', 'null'] }, exit_row: { type: 'boolean' } } } },
        type_prices: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'price_range'], properties: { type: { type: 'string' }, price_range: { type: ['string', 'null'] } } } },
        travelers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['traveler_index', 'seat', 'price', 'active'], properties: { traveler_index: { type: 'integer' }, seat: { type: ['string', 'null'] }, price: { type: ['number', 'null'] }, active: { type: 'boolean' } } } },
        seats_total: { type: ['number', 'null'] },
        total: { type: ['number', 'null'] },
        message: { type: ['string', 'null'] }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    if (location.hostname !== 'www.alaskaair.com' || !/^\/book\/seat-selection/.test(location.pathname)) return { status: 'wrong_page', flight: null, aircraft: null, seats: [], type_prices: [], travelers: [], seats_total: null, total: null, message: 'Not on Alaska\'s Seats step.' };
    const main = text(document.querySelector('main') || document.body);
    const typeOf = (cls, label) => /seat-unavailable|Unavailable/.test(cls + ' ' + label) ? 'unavailable' : /seat-first|First Class/i.test(cls + label) ? 'first' : /seat-premium/.test(cls) ? 'premium' : /seat-mainpreferred/.test(cls) ? 'main_preferred' : /seat-main/.test(cls) ? 'main' : 'other';
    const seats = [];
    for (const b of document.querySelectorAll('button.seat:not(.legend-seat)')) {
      const label = b.getAttribute('aria-label') || '';
      const m = /^(\d{1,2}[A-K])\b/.exec(label);
      if (!m) continue;
      const type = typeOf(String(b.className), label);
      const available = type !== 'unavailable' && !b.disabled;
      if (!available && !input?.include_unavailable) continue;
      seats.push({ seat: m[1], type, available, position: (/(Window|Aisle|Middle) seat/.exec(label) || [])[1]?.toLowerCase() || null, exit_row: /exit row/i.test(label) });
    }
    const typePrices = [];
    for (const [type, re] of [['first', /First Class (\+\$[\d,]+ - \$[\d,]+|Included)/], ['premium', /Premium Class (\+\$[\d,]+(?: - \$[\d,]+)?)/], ['main_preferred', /Main Preferred (\+\$[\d,]+(?: - \$[\d,]+)?)/]]) {
      const m = re.exec(main);
      if (m) typePrices.push({ type, price_range: m[1] + ' USD' });
    }
    if (/Main Cabin Wi-Fi/.test(main)) typePrices.push({ type: 'main', price_range: null });
    const travelers = [...document.querySelectorAll('button.seat')].filter((b) => /Traveler named/.test(b.getAttribute('aria-label') || '')).map((b, i) => {
      const l = b.getAttribute('aria-label');
      const seat = (/^(\d{1,2}[A-K])\. Traveler/.exec(l) || [])[1] || null;
      const price = /Seat price is \$([\d,.]+)/.exec(l);
      return { traveler_index: i, seat, price: price ? Number(price[1].replace(/,/g, '')) : seat ? 0 : null, active: /seat-active/.test(b.className) };
    });
    const flight = (/\b((?:AS|HA) \d{1,4}) Operated by/.exec(main) || [])[1] || null;
    const aircraft = (/\| ([A-Z][^|]{3,60}?) (?:[A-K] )+\d/.exec(main) || [])[1] || null;
    const all = text(document.body);
    const st = /Seats? total \$([\d,]+(?:\.\d\d)?)/.exec(all);
    const tot = /Total \$([\d,]+\.\d\d)/.exec(all);
    return { status: seats.length || flight ? 'ok' : 'not_ready', flight, aircraft, seats, type_prices: typePrices, travelers, seats_total: st ? Number(st[1].replace(/,/g, '')) : null, total: tot ? Number(tot[1].replace(/,/g, '')) : null, message: (seats.length ? '' : 'No seats are drawn yet. ') + 'Use select_seat (Saver fares get not_included_in_fare for standard seats) with a seat and max_price (or release: true). Use continue_checkout seats_action next_flight / skip_seats / save_and_continue to move on.' };
  }
}]
