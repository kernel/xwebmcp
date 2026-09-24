[{
  kind: 'cdp',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'search_flights',
    description: 'Read the first page of Alaska cash-fare outbound flight options. Round trips return outbound choices with displayed round-trip per-adult starting fares, not selected return flights. Adults only; local airport times; no booking. Invoke serially in a dedicated tab with a 120-second timeout.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        origin: { type: 'string', pattern: '^[A-Z]{3}$', description: 'Exact origin IATA airport code, not a city-area code.' },
        destination: { type: 'string', pattern: '^[A-Z]{3}$', description: 'Exact destination IATA airport code.' },
        depart_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD, today through 330 days ahead (UTC validation).' },
        return_date: { type: 'string', format: 'date', description: 'Required for round_trip; prohibited for one_way.' },
        trip_type: { type: 'string', enum: ['one_way', 'round_trip'] },
        passengers: { type: 'integer', minimum: 1, maximum: 9, description: 'Adult passengers; children and lap infants are not supported.' }
      },
      required: ['origin', 'destination', 'depart_date', 'trip_type', 'passengers'],
      allOf: [{ if: { properties: { trip_type: { const: 'round_trip' } } }, then: { required: ['return_date'] }, else: { not: { required: ['return_date'] } } }]
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['ok', 'no_results', 'error'] },
        results_url: { type: 'string', format: 'uri' },
        result_count: { type: 'integer', minimum: 0 },
        total_results: { type: ['integer', 'null'], minimum: 0 },
        has_more: { type: 'boolean' },
        direction: { type: 'string', const: 'outbound' },
        passengers: { type: 'integer', minimum: 1, maximum: 9 },
        price_disclaimer: { type: 'string' },
        message: { type: ['string', 'null'] },
        flights: {
          type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              airlines: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Marketing airlines from segment details.' },
              flight_numbers: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Ordered segments, each formatted as airline name plus flight number.' },
              departure_airport: { type: 'string', pattern: '^[A-Z]{3}$' },
              arrival_airport: { type: 'string', pattern: '^[A-Z]{3}$' },
              departure_time: { type: 'string', pattern: '^(0?[1-9]|1[0-2]):[0-5][0-9] [ap]m$' },
              arrival_time: { type: 'string', pattern: '^(0?[1-9]|1[0-2]):[0-5][0-9] [ap]m$' },
              departure_date: { type: 'string', format: 'date' },
              arrival_date_label: { type: 'string', minLength: 1, description: 'Site-local calendar label, e.g. Sunday, October 11th; not a UTC timestamp.' },
              duration_minutes: { type: 'integer', minimum: 1 },
              stops: { type: 'integer', minimum: 0 },
              price: {
                type: 'object', additionalProperties: false,
                properties: {
                  amount: { type: 'number', exclusiveMinimum: 0 },
                  currency: { type: 'string', const: 'USD' },
                  basis: { type: 'string', enum: ['one_way_per_adult', 'round_trip_per_adult'] },
                  fare: { type: 'string', minLength: 1 }
                }, required: ['amount', 'currency', 'basis', 'fare']
              }
            },
            required: ['airlines', 'flight_numbers', 'departure_airport', 'arrival_airport', 'departure_time', 'arrival_time', 'departure_date', 'arrival_date_label', 'duration_minutes', 'stops', 'price']
          }
        }
      },
      required: ['status', 'results_url', 'result_count', 'total_results', 'has_more', 'direction', 'passengers', 'price_disclaimer', 'message', 'flights']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  },
  execute: async (input) => {
    const dateOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!/^[A-Z]{3}$/.test(input.origin) || !/^[A-Z]{3}$/.test(input.destination) || input.origin === input.destination) throw new Error('Use distinct uppercase IATA airport codes.');
    if (!['one_way', 'round_trip'].includes(input.trip_type) || !Number.isInteger(input.passengers) || input.passengers < 1 || input.passengers > 9) throw new Error('Specify trip_type and 1–9 adult passengers.');
    if (!dateOK(input.depart_date) || (input.trip_type === 'round_trip' ? !dateOK(input.return_date) || input.return_date < input.depart_date : input.return_date !== undefined)) throw new Error('Invalid dates or return_date incompatible with trip_type.');
    const today = new Date().toISOString().slice(0, 10);
    const lastDay = new Date(Date.parse(today) + 330 * 86400000).toISOString().slice(0, 10);
    if (input.depart_date < today || input.depart_date > lastDay || (input.return_date && input.return_date > lastDay)) throw new Error('Dates must be today through 330 days ahead.');
    const query = new URLSearchParams({ O: input.origin, D: input.destination, OD: input.depart_date, A: String(input.passengers), RT: String(input.trip_type === 'round_trip'), locale: 'en-us' });
    if (input.return_date) query.set('DD', input.return_date);
    const url = 'https://www.alaskaair.com/search/results?' + query;
    const result = { status: 'error', results_url: url, result_count: 0, total_results: null, has_more: false, direction: 'outbound', passengers: input.passengers, price_disclaimer: '', message: null, flights: [] };
    const deadline = Date.now() + 105000;
    const seconds = cap => Math.max(0.1, Math.min(cap, (deadline - Date.now()) / 1000));
    try {
      const current = new URL((await pageInfo()).url);
      const target = new URL(url);
      const atSearchEntry = current.origin === target.origin && current.pathname === target.pathname && current.search === target.search;
      if (!atSearchEntry) await gotoUrl(url);
      for (let attempt = 0; attempt < 2; attempt++) {
        // Refresh matching searches too, so repeat invocations get current fares.
        if (atSearchEntry || attempt > 0) await gotoUrl(url);
        await waitForLoad(seconds(12));
        const title = await js(() => document.title);
        if (!/proxy error/i.test(title)) break;
        if (attempt === 1) throw new Error('Proxy error loading results after one read-only navigation retry.');
      }
      if (!await waitForElement('.flight-card-wrapper, .no-flights', { timeoutSec: seconds(70) })) throw new Error('Timed out waiting for flight cards or an explicit no-results notice.');
      const page = await js(() => ({
        url: location.href,
        empty: document.querySelector('.no-flights')?.innerText.trim() || null,
        count: document.querySelector('.display-count-text')?.innerText || '',
        disclaimer: document.querySelector('.flight-disclaimer')?.innerText || '',
        cards: [...document.querySelectorAll('.flight-card-wrapper')].map(card => {
          const text = selector => card.querySelector(selector)?.textContent.trim().replace(/\s+/g, ' ') || '';
          const duration = text('.duration').match(/^(?:(\d+)h\s*)?(?:(\d+)m)?$/);
          const stopMatch = card.querySelector('[data-testid^="flight-details-"]')?.getAttribute('data-testid').match(/-stops-(\d+)$/);
          const fares = [...card.querySelectorAll('button.fare-tile, button[data-testid^="valuetile-"]')].filter(b => b.getBoundingClientRect().height > 0 && !b.disabled).map(b => {
            const t = b.innerText;
            const amount = t.match(/\$([\d,]+(?:\.\d{1,2})?)/);
            return amount ? { amount: Number(amount[1].replace(/,/g, '')), currency: 'USD', basis: /round trip/i.test(t) ? 'round_trip_per_adult' : /one way/i.test(t) ? 'one_way_per_adult' : null, fare: t.split('\n').map(x => x.trim()).find(Boolean) } : null;
          }).filter(Boolean).sort((a, b) => a.amount - b.amount);
          return {
            detail_id: card.querySelector('[id^="details-"]')?.id,
            departure_airport: text('.departure .airport-code'), arrival_airport: text('.arrival .airport-code'),
            departure_time: text('.departure-time'), arrival_time: text('.arrival-time'),
            duration_minutes: duration ? Number(duration[1] || 0) * 60 + Number(duration[2] || 0) : 0,
            stops: stopMatch ? Number(stopMatch[1]) : -1, price: fares[0] || null
          };
        })
      }));
      if (new URL(page.url).origin !== 'https://www.alaskaair.com' || new URL(page.url).search !== new URL(url).search) throw new Error('Search URL changed unexpectedly; refusing mismatched results.');
      result.results_url = page.url;
      result.price_disclaimer = page.disclaimer;
      if (!page.cards.length && page.empty && /^No results available\./.test(page.empty)) return { ...result, status: 'no_results', total_results: 0, message: page.empty };
      const count = page.count.match(/Showing\s+(\d+)\s+of\s+(\d+)/i);
      if (!page.cards.length || !count || Number(count[1]) !== page.cards.length || Number(count[2]) < page.cards.length) throw new Error('Missing or inconsistent first-page result count.');
      if (!/per passenger/i.test(page.disclaimer)) throw new Error('Unrecognized fare price basis.');
      const flights = [];
      for (const card of page.cards) {
        if (Date.now() >= deadline) throw new Error('Timed out reading flight details.');
        const time = /^(0?[1-9]|1[0-2]):[0-5][0-9] [ap]m$/;
        if (!card.detail_id || card.departure_airport !== input.origin || card.arrival_airport !== input.destination || !time.test(card.departure_time) || !time.test(card.arrival_time) || card.duration_minutes < 1 || card.stops < 0 || !card.price || card.price.amount <= 0 || card.price.basis !== input.trip_type + '_per_adult') throw new Error('Incomplete or inconsistent flight card; refusing partial output.');
        const detailSelector = '#fareDetails[open] .segment-details [data-testid="airline-name"]';
        await click('#' + card.detail_id, { timeoutSec: seconds(5) });
        if (!await waitForElement(detailSelector, { timeoutSec: seconds(8) })) {
          const closed = await js(() => !document.querySelector('#fareDetails[open]'));
          if (!closed) throw new Error('Flight details opened but did not finish rendering.');
          await click('#' + card.detail_id, { timeoutSec: seconds(5) });
          if (!await waitForElement(detailSelector, { timeoutSec: seconds(8) })) throw new Error('Flight details did not appear: ' + card.detail_id);
        }
        const details = await js(() => [...document.querySelectorAll('#fareDetails .segment-details')].map(s => ({
          number: s.querySelector('[data-testid="airline-name"]')?.textContent.trim().replace(/\s+/g, ' ') || '',
          dates: [...s.querySelectorAll('.flight-date')].map(e => e.textContent.trim()),
          times: [...s.querySelectorAll('.flight-time')].map(e => e.textContent.trim()),
          airports: [...s.querySelectorAll('.station.heading-2xs')].map(e => e.textContent.match(/\(([A-Z]{3})\)/)?.[1] || '')
        })));
        await pressKey('Escape');
        if (!await waitForElement('#fareDetails[open]', { state: 'detached', timeoutSec: seconds(3) })) throw new Error('Flight details could not be dismissed.');
        if (!details.length || details.some(s => !/^.+\s\d+[A-Z]?$/.test(s.number)) || details[0].airports[0] !== input.origin || details.at(-1).airports[1] !== input.destination || details[0].times[0] !== card.departure_time || details.at(-1).times[1] !== card.arrival_time || !details.at(-1).dates[1]) throw new Error('Incomplete or mismatched segment details.');
        const { detail_id, ...flight } = card;
        flights.push({ ...flight, airlines: [...new Set(details.map(s => s.number.replace(/\s\d+[A-Z]?$/, '')))], flight_numbers: details.map(s => s.number), departure_date: input.depart_date, arrival_date_label: details.at(-1).dates[1] });
      }
      return { ...result, status: 'ok', result_count: flights.length, total_results: Number(count[2]), has_more: Number(count[2]) > flights.length, flights };
    } catch (error) {
      return { ...result, message: String(error.message || error) };
    }
  }
}]
