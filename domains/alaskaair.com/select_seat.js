[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'select_seat',
    description: 'Choose a seat for the active traveler on Alaska\'s Seats step for the current flight, or release that traveler\'s seat (release: true). Choosing needs max_price, the most the user agreed to pay: Alaska shows the exact price only after the click, so if it is higher the tool releases the seat again and reports price_too_high. When the fare does not include standard seats (Saver), Alaska refuses and the tool closes the notice and reports not_included_in_fare. Reports the seat, its price, the seats total and booking total before and after. Changes the cart only; nothing is purchased.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        seat: { type: 'string', pattern: '^[0-9]{1,2}[A-K]$' },
        max_price: { type: 'number', minimum: 0 },
        release: { type: 'boolean', description: 'Release the active traveler\'s seat on this flight instead of choosing one.' }
      },
      oneOf: [{ required: ['seat', 'max_price'], not: { required: ['release'] } }, { required: ['release'], not: { anyOf: [{ required: ['seat'] }, { required: ['max_price'] }] } }]
    },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['status', 'seat', 'price', 'total_before', 'total_after', 'message'],
      properties: {
        status: { enum: ['selected', 'released', 'price_too_high', 'not_included_in_fare', 'unavailable', 'not_found', 'nothing_to_release', 'no_change', 'invalid_input', 'wrong_page'] },
        seat: { type: ['string', 'null'] },
        price: { type: ['number', 'null'] },
        seats_total_after: { type: ['number', 'null'] },
        total_before: { type: ['number', 'null'] },
        total_after: { type: ['number', 'null'] },
        message: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    // The seat and booking totals sit in a footer bar outside <main>.
    const num = (re) => { const m = re.exec(text(document.body)); return m ? Number(m[1].replace(/,/g, '')) : null; };
    const total = () => num(/Total \$([\d,]+\.\d\d)/);
    const seatsTotal = () => num(/Seats? total \$([\d,]+(?:\.\d\d)?)/);
    const out = (status, message, extra = {}) => ({ status, seat: null, price: null, seats_total_after: null, total_before: null, total_after: null, message, ...extra });
    const release = input?.release === true;
    if (release ? input.seat !== undefined || input.max_price !== undefined : !(typeof input?.seat === 'string' && /^[0-9]{1,2}[A-K]$/.test(input.seat) && Number(input.max_price) >= 0)) return out('invalid_input', 'Give seat (row number plus letter A-K, e.g. 22C) and max_price, or release: true alone; nothing was clicked.');
    if (location.hostname !== 'www.alaskaair.com' || !/^\/book\/seat-selection/.test(location.pathname)) return out('wrong_page', 'Not on Alaska\'s Seats step.');
    const active = () => [...document.querySelectorAll('button.seat')].find((b) => /Traveler named/.test(b.getAttribute('aria-label') || '') && /seat-active/.test(b.className)) || [...document.querySelectorAll('button.seat')].find((b) => /Traveler named/.test(b.getAttribute('aria-label') || ''));
    const current = () => { const l = active()?.getAttribute('aria-label') || ''; const s = (/^(\d{1,2}[A-K])\. Traveler/.exec(l) || [])[1] || null; const p = /Seat price is \$([\d,.]+)/.exec(l); return { seat: s, price: p ? Number(p[1].replace(/,/g, '')) : s ? 0 : null }; };
    const before = total();
    const clear = async () => {
      const b = document.querySelector('button.clear-selection');
      if (!b) return false;
      b.click();
      for (let i = 0; i < 20 && current().seat; i++) await sleep(200);
      return !current().seat;
    };
    if (release) {
      const c = current();
      if (!c.seat) return out('nothing_to_release', 'The active traveler has no seat on this flight.', { total_before: before, total_after: before });
      const ok = await clear();
      await sleep(400);
      return out(ok ? 'released' : 'no_change', ok ? 'Released seat ' + c.seat + '.' : 'Alaska kept the seat; call list_seat_map.', { seat: c.seat, price: c.price, seats_total_after: seatsTotal(), total_before: before, total_after: total() });
    }
    const target = [...document.querySelectorAll('button.seat:not(.legend-seat)')].find((b) => new RegExp('^' + input.seat + '\\b').test(b.getAttribute('aria-label') || ''));
    if (!target) return out('not_found', 'Seat ' + input.seat + ' is not on this flight\'s map.', { total_before: before });
    if (/seat-unavailable/.test(target.className) || target.disabled) return out('unavailable', 'Seat ' + input.seat + ' is unavailable.', { total_before: before });
    if (current().seat === input.seat) return out('selected', 'Seat ' + input.seat + ' was already chosen; nothing was clicked.', { seat: input.seat, price: current().price, seats_total_after: seatsTotal(), total_before: before, total_after: before });
    const prev = current().seat;
    target.click();
    const modal = document.querySelector('#seat-selection-modal');
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      if (current().seat === input.seat) break;
      if (/isn.t included in/i.test(text(modal))) {
        const notice = (/^(.*?upgrade\.)/.exec(text(modal)) || [null, 'Alaska says this seat is not included in the fare.'])[1].slice(0, 200);
        const back = [...modal.querySelectorAll('seatsui-auro-button, button')].find((b) => /Return to seat selection/i.test(text(b)));
        (back?.shadowRoot?.querySelector('button') || back)?.click();
        await sleep(400);
        return out('not_included_in_fare', notice, { seat: input.seat, total_before: before, total_after: total() });
      }
    }
    const c = current();
    if (c.seat !== input.seat) return out('no_change', 'Alaska did not assign ' + input.seat + '; call list_seat_map.', { total_before: before, total_after: total() });
    await sleep(300);
    if (c.price !== null && c.price > Number(input.max_price) + 0.005) {
      await clear();
      return out('price_too_high', 'Seat ' + input.seat + ' costs $' + c.price + ', above max_price $' + input.max_price + '; released it again' + (prev ? ' (the previous seat ' + prev + ' was not restored; choose it again if wanted)' : '') + '.', { seat: input.seat, price: c.price, seats_total_after: seatsTotal(), total_before: before, total_after: total() });
    }
    return out('selected', 'Chose seat ' + input.seat + ' for $' + c.price + '.', { seat: input.seat, price: c.price, seats_total_after: seatsTotal(), total_before: before, total_after: total() });
  }
}]
