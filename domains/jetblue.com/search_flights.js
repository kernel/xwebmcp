(() => {
  const airport = { type: 'string', pattern: '^[A-Z]{3}$' };
  const date = { type: 'string', format: 'date' };
  const time = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' };
  const nonempty = { type: 'string', minLength: 1 };
  const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const inputSchema = {
    type: 'object', additionalProperties: false,
    required: ['origin', 'destination', 'departDate', 'tripType'],
    properties: {
      origin: airport, destination: airport, departDate: date, returnDate: date,
      tripType: { type: 'string', enum: ['one_way', 'round_trip'] },
      passengers: { type: 'integer', minimum: 1, maximum: 7, default: 1, description: 'Adults only; JetBlue permits at most seven travelers. Children and infants are not supported.' }
    },
    allOf: [{ if: { properties: { tripType: { const: 'round_trip' } } }, then: { required: ['returnDate'] }, else: { not: { required: ['returnDate'] } } }]
  };
  const outputSchema = object({
    status: { type: 'string', enum: ['results', 'no_results'] },
    resultsUrl: { type: 'string', format: 'uri' },
    resultCount: { type: 'integer', minimum: 0, description: 'Returned cards, not total available inventory.' },
    hasMore: { type: 'boolean' }, direction: { type: 'string', const: 'outbound' },
    timeBasis: { type: 'string', const: 'airport_local' }, pricingNote: nonempty,
    flights: { type: 'array', items: object({
      airline: nonempty,
      flightNumbers: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[A-Z0-9]{2,3} [0-9]{1,4}[A-Z]?$' } },
      departureAirport: airport, arrivalAirport: airport,
      departureDate: date, arrivalDate: date, departureTime: time, arrivalTime: time,
      durationMinutes: { type: 'integer', minimum: 1 }, stops: { type: 'integer', minimum: 0 },
      price: object({
        amount: { type: 'number', exclusiveMinimum: 0 }, currencySymbol: { type: 'string', const: '$' },
        fareName: nonempty, displayText: nonempty, basis: { type: 'string', const: 'displayed_not_trip_total' }
      })
    }) }
  });
  return [{
    kind: 'cdp', match: { url_patterns: ['https://jetblue.com/*', 'https://*.jetblue.com/*'] },
    tool: {
      name: 'search_flights',
      description: 'Search JetBlue cash fares for 1–7 adults. Return every flight card in the initial outbound results batch, not subsequent load-more batches or selected return flights. Round-trip fares are displayed outbound offers, not complete trip totals. Never books or selects a fare.',
      inputSchema, outputSchema, annotations: { readOnlyHint: true }
    },
    execute: async (input) => {
      const allowed = ['origin', 'destination', 'departDate', 'returnDate', 'tripType', 'passengers'];
      if (!input || typeof input !== 'object' || Object.keys(input).some(k => !allowed.includes(k))) throw new Error('Invalid input fields');
      const { origin, destination, departDate, returnDate, tripType } = input;
      const passengers = input.passengers ?? 1;
      const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
      if (!/^[A-Z]{3}$/.test(origin || '') || !/^[A-Z]{3}$/.test(destination || '') || origin === destination) throw new Error('Use distinct uppercase IATA airport codes');
      if (!validDate(departDate) || departDate < new Date().toISOString().slice(0, 10)) throw new Error('departDate must be a real non-past ISO date');
      if (!['one_way', 'round_trip'].includes(tripType) || (tripType === 'round_trip' ? !validDate(returnDate) || returnDate < departDate : returnDate !== undefined)) throw new Error('Round trips require returnDate >= departDate; one-way trips prohibit returnDate');
      if (!Number.isInteger(passengers) || passengers < 1 || passengers > 7) throw new Error('passengers must be 1–7 adults');
      const query = new URLSearchParams({ adults: String(passengers), children: '0', infants: '0', from: origin, to: destination, depart: departDate, isMultiCity: 'false', noOfRoute: '1', roundTripFaresFlag: 'false', sharedMarket: 'false', usePoints: 'false' });
      if (returnDate) query.set('return', returnDate);
      const url = 'https://www.jetblue.com/booking/flights?' + query;
      const deadline = Date.now() + 100000;
      const currentUrl = new URL((await pageInfo()).url);
      const suitable = currentUrl.origin === 'https://www.jetblue.com' &&
        ['/', '/booking/flights'].includes(currentUrl.pathname);
      if (!suitable) {
        await gotoUrl('https://www.jetblue.com/');
        if (!await waitForElement('input[name="from"]', { state: 'attached', timeoutSec: 30 })) {
          throw new Error('Flight search entry point did not load; availability is unknown');
        }
      }
      await cdp('Network.enable', { maxTotalBufferSize: 50000000, maxResourceBufferSize: 10000000 });
      const inventoryResponse = waitForEvent('Network.responseReceived', {
        timeoutSec: Math.max(1, Math.min(95, (deadline - Date.now()) / 1000)),
        predicate: event => event.params.response.url === 'https://www.jetblue.com/api/ecom/cb-flight-search/v1/search/NGB'
      }).catch(error => ({ error: String(error) }));
      await gotoUrl(url);
      const ready = await waitForElement('.flight-result-item .cb-bundle-price__price, .flight-not-found-card h2', { timeoutSec: Math.max(1, (deadline - Date.now()) / 1000) });
      if (!ready) throw new Error('Results timeout: no priced flight cards or explicit no-flights message within the search deadline');
      const response = await inventoryResponse;
      if (!response || response.error) throw new Error('Inventory request failed or timed out; availability is unknown');
      if (response.params.response.status < 200 || response.params.response.status >= 300) throw new Error('Inventory HTTP failure; availability is unknown');
      const body = await cdp('Network.getResponseBody', { requestId: response.params.requestId });
      if (body.base64Encoded) throw new Error('Unsupported inventory response encoding');
      const inventory = JSON.parse(body.body);
      const outbound = inventory.data?.searchResults?.find(r => r.searchComponent?.from === origin && r.searchComponent?.to === destination && r.searchComponent?.date === departDate);
      if (inventory.status?.transactionStatus !== 'success' || !Array.isArray(outbound?.productOffers)) throw new Error('Inventory search failed or returned an unexpected route; availability is unknown');
      const result = await js(({ origin, destination, departDate, url }) => {
        const actual = new URL(location.href), expected = new URL(url);
        if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || [...expected.searchParams].some(([key, value]) => actual.searchParams.get(key) !== value)) throw new Error('Unexpected navigation; refusing to return unrelated results');
        const txt = e => (e?.textContent || '').replace(/\s+/g, ' ').trim();
        const rows = [...document.querySelectorAll('.flight-result-item')].filter(e => e.getClientRects().length);
        const empty = [...document.querySelectorAll('.flight-not-found-card h2')].some(e => e.getClientRects().length && /No flights have been found for your search criteria\./i.test(txt(e)));
        if (!rows.length && !empty) throw new Error('Unrecognized results state');
        const time = s => {
          const m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
          if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] > 59) throw new Error('Unrecognized local time: ' + s);
          return String(+m[1] % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0)).padStart(2, '0') + ':' + m[2];
        };
        const flights = rows.map((row, index) => {
          const get = s => txt(row.querySelector(s));
          const airline = [...row.querySelectorAll('.airline-name')].map(e => {
            const copy = e.cloneNode(true);
            copy.querySelectorAll('.flight-codes').forEach(c => c.remove());
            return txt(copy);
          }).filter(Boolean).join(' / ');
          const flightNumbers = [...row.querySelectorAll('.flight-codes')].map(e => txt(e).replace(/,$/, '').trim());
          const departureAirport = get('.flight-panel__departure .flight-airport'), arrivalAirport = get('.flight-panel__arrival .flight-airport');
          const duration = get('.flight-panel__duration').match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/);
          const durationMinutes = duration ? +(duration[1] || 0) * 60 + +(duration[2] || 0) : 0;
          const stopText = get('.flight-panel__stops');
          const stops = /^Nonstop$/i.test(stopText) ? 0 : /^\d+ Stops?$/i.test(stopText) ? parseInt(stopText, 10) : NaN;
          const arrivalText = get('.arrival-offset');
          const dayOffset = arrivalText.match(/\+(\d+)\s*days?/i);
          if (/\+/.test(arrivalText) && !dayOffset) throw new Error('Unrecognized arrival day offset');
          const arrivalDate = new Date(Date.parse(departDate) + Number(dayOffset?.[1] || 0) * 86400000).toISOString().slice(0, 10);
          const fares = [...row.querySelectorAll('.cb-fare-card')].flatMap(card => {
            const displayText = txt(card.querySelector('.cb-bundle-price__price'));
            const m = displayText.match(/^\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/);
            return m ? [{ amount: Number(m[1].replace(/,/g, '')), currencySymbol: '$', fareName: txt(card.querySelector('b')), displayText, basis: 'displayed_not_trip_total' }] : [];
          }).sort((a, b) => a.amount - b.amount);
          if (!airline || !flightNumbers.length || flightNumbers.some(n => !/^[A-Z0-9]{2,3} [0-9]{1,4}[A-Z]?$/.test(n)) || departureAirport !== origin || arrivalAirport !== destination || !durationMinutes || !Number.isInteger(stops) || !fares.length || !fares[0].fareName || fares[0].amount <= 0) throw new Error('Incomplete or unsupported flight card ' + (index + 1) + '; no partial results returned');
          return { airline, flightNumbers, departureAirport, arrivalAirport, departureDate: departDate, arrivalDate, departureTime: time(get('.flight-panel__departure .flight-time')), arrivalTime: time(get('.flight-panel__arrival .flight-time')), durationMinutes, stops, price: fares[0] };
        });
        return {
          status: flights.length ? 'results' : 'no_results', resultsUrl: location.href, resultCount: flights.length,
          hasMore: [...document.querySelectorAll('button')].some(e => e.getClientRects().length && !e.disabled && /more flights/i.test(txt(e))),
          direction: 'outbound', timeBasis: 'airport_local',
          pricingNote: 'Lowest displayed cash fare per outbound card. The dollar symbol is preserved without inferring an ISO currency or passenger/trip total. Return options require an outbound selection and are not included.',
          flights
        };
      }, { arg: { origin, destination, departDate, url } });
      if ((result.resultCount === 0) !== (outbound.productOffers.length === 0)) throw new Error('Inventory and visible results disagree; availability is unknown');
      return result;
    }
  }];
})()
