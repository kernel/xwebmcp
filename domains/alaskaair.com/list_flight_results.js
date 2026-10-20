[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'list_flight_results',
    description: 'List the flights currently shown on Alaska\'s results page (www.alaskaair.com/search/results) for the leg being chosen, departing or returning, without searching again: result_index, flight numbers, times, airports, stops, duration and each fare column (Saver, Main, Premium, First) with its displayed per-passenger price and seats-left note. Round-trip prices are Alaska\'s round-trip per-passenger totals for that combination. Read-only. Use result_index and the fare name with select_fare. Only the results loaded on the page are listed (use the site\'s "Show more results" yourself if needed).',
    inputSchema: { type: 'object', additionalProperties: false, properties: { max_results: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['status', 'leg', 'price_basis', 'flights', 'message'],
      properties: {
        status: { enum: ['ok', 'no_results', 'wrong_page'] },
        leg: { type: ['string', 'null'], enum: ['departing', 'returning', null] },
        price_basis: { type: ['string', 'null'], description: 'Alaska\'s fare note, e.g. "All fares are round-trip per passenger, including taxes and fees."' },
        message: { type: ['string', 'null'] },
        flights: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            required: ['result_index', 'flight_numbers', 'departure_time', 'arrival_time', 'departure_airport', 'arrival_airport', 'stops_label', 'duration', 'fares'],
            properties: {
              result_index: { type: 'integer', minimum: 0 },
              flight_numbers: { type: 'array', items: { type: 'string' } },
              departure_time: { type: 'string' }, arrival_time: { type: 'string' },
              departure_airport: { type: 'string' }, arrival_airport: { type: 'string' },
              stops_label: { type: 'string', description: 'e.g. Nonstop, 1 stop SFO.' },
              duration: { type: 'string' },
              fares: {
                type: 'array', items: {
                  type: 'object', additionalProperties: false,
                  required: ['fare', 'available', 'price', 'note'],
                  properties: { fare: { type: 'string' }, available: { type: 'boolean' }, price: { type: ['number', 'null'] }, note: { type: ['string', 'null'] } }
                }
              }
            }
          }
        }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    const max = Math.max(1, Math.min(50, Number(input?.max_results) || 20));
    if (location.hostname !== 'www.alaskaair.com' || !/^\/search\/results/.test(location.pathname)) return { status: 'wrong_page', leg: null, price_basis: null, flights: [], message: 'Not on Alaska\'s flight results page; run search_flights first.' };
    const main = text(document.querySelector('main') || document.body);
    if (/Trip summary Clear all selections/.test(main) && !document.querySelector('[data-testid^="valuetile-"]')) return { status: 'wrong_page', leg: null, price_basis: null, flights: [], message: 'Both flights are chosen and Alaska shows the trip summary; use get_trip_summary, or the site\'s "Change flight" to choose again.' };
    const leg = /Depart: [A-Z]{3}.[A-Z]{3}/.test(main) ? 'returning' : 'departing';
    const basis = (/All fares are [^.]+\./.exec(main) || [])[0] || null;
    const rows = new Map();
    for (const tile of document.querySelectorAll('[data-testid^="valuetile-"]')) {
      const m = /^valuetile-(\d+)-(\d+)$/.exec(tile.dataset.testid);
      if (!m || !tile.getClientRects().length) continue;
      const i = Number(m[1]);
      if (!rows.has(i)) rows.set(i, { card: tile.closest('.flight-card-container'), tiles: [] });
      rows.get(i).tiles[Number(m[2])] = tile;
    }
    const flights = [];
    for (const [i, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      if (flights.length >= max) break;
      const c = row.card;
      if (!c) continue;
      const q = (s) => text(c.querySelector(s));
      const codes = [...c.querySelectorAll('.airport-code')].map(text);
      const fares = row.tiles.filter(Boolean).map((t) => {
        const name = text(t.querySelector('.cos-primary')) || text(t).split(' ')[0];
        const priceText = text(t.querySelector('[data-testid="regular-price"], .price-line'));
        const price = /\$([\d,]+(?:\.\d\d)?)/.exec(priceText);
        const note = text(t).replace(name, '').replace(priceText, '').replace(/Round trip|One way/i, '').trim() || null;
        return { fare: name, available: !!price && !t.disabled, price: price ? Number(price[1].replace(/,/g, '')) : null, note };
      });
      flights.push({
        result_index: i,
        flight_numbers: q('.flight-number').split(/\s*[,/]\s*|\s+(?=[A-Z0-9]{2} \d)/).filter(Boolean),
        departure_time: q('[data-testid="departure-time"]'), arrival_time: q('[data-testid="arrival-time"]'),
        departure_airport: codes[0] || '', arrival_airport: codes[codes.length - 1] || '',
        stops_label: q('[part="stop-label"]') || (/Nonstop/.test(text(c)) ? 'Nonstop' : ''),
        duration: q('.duration'), fares
      });
    }
    return { status: flights.length ? 'ok' : 'no_results', leg, price_basis: basis, flights, message: flights.length ? null : 'No flight results are shown.' };
  }
}]
