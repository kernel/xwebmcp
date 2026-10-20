[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'select_fare',
    description: 'Choose one fare tile (Saver, Main, Premium or First) for one flight on Alaska\'s results page, after checking its displayed price. Alaska then either opens a dialog that needs an answer (Saver restrictions with an upgrade-to-Main offer, or a refundable-itinerary upsell; restrictions are returned so the user can review them), moves on to the return flights, or shows the trip summary. Same-document; purchases and holds nothing. Answer any open dialog with respond_fare_offer.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['result_index', 'fare', 'expected_price'],
      properties: {
        result_index: { type: 'integer', minimum: 0, description: 'From list_flight_results.' },
        fare: { type: 'string', enum: ['Saver', 'Main', 'Premium', 'First'] },
        expected_price: { type: 'number', exclusiveMinimum: 0, description: 'Displayed price from list_flight_results; the tool refuses if it differs.' }
      }
    },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['status', 'message'],
      properties: {
        status: { enum: ['offer_open', 'other_dialog_open', 'return_flights_shown', 'trip_summary_shown', 'price_changed', 'not_found', 'wrong_page', 'no_change'] },
        open_offer: { type: ['string', 'null'], enum: ['saver_restrictions', 'refundable_upsell', null] },
        displayed_price: { type: ['number', 'null'] },
        offer_summary: { type: ['string', 'null'], description: 'Dialog text: compared benefits and the upgrade or refund price.' },
        restrictions: { type: 'array', items: { type: 'string' }, description: 'Saver fare rules shown by Alaska (seats, carry-on and boarding, changes/cancellation, points).' },
        message: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    const cols = { Saver: 0, Main: 1, Premium: 2, First: 3 };
    const out = (status, message, extra = {}) => ({ status, open_offer: null, displayed_price: null, offer_summary: null, restrictions: [], message, ...extra });
    if (!Number.isInteger(input?.result_index) || !(input?.fare in cols) || !(Number(input?.expected_price) > 0)) return out('not_found', 'Invalid input: result_index, fare and expected_price are required; nothing was clicked.');
    if (location.hostname !== 'www.alaskaair.com' || !/^\/search\/results/.test(location.pathname)) return out('wrong_page', 'Not on Alaska\'s flight results page.');
    const open = () => document.querySelector('fs-auro-dialog#refundable-upsell-modal[open]') ? 'refundable_upsell' : document.querySelector('fs-auro-dialog#saver-upsell-dialog[open]') ? 'saver_restrictions' : null;
    if (open()) return out('offer_open', 'A fare dialog is already open; answer it with respond_fare_offer first. Nothing was clicked.', { open_offer: open() });
    const blocking = [...document.querySelectorAll('fs-auro-dialog[open]')].find((x) => text(x));
    if (blocking) return out('other_dialog_open', 'Alaska has a dialog open (' + (blocking.id || 'unnamed') + '); the user must answer it in the browser first. Nothing was clicked.', { offer_summary: text(blocking).slice(0, 900) });
    const tiles = [...document.querySelectorAll('[data-testid^="valuetile-' + input.result_index + '-"]')].filter((t) => t.getClientRects().length);
    const tile = tiles.find((t) => text(t.querySelector('.cos-primary')) === input.fare) || document.querySelector('[data-testid="valuetile-' + input.result_index + '-' + cols[input.fare] + '"]');
    if (!tile || text(tile.querySelector('.cos-primary')) !== input.fare) return out('not_found', 'No ' + input.fare + ' fare for result ' + input.result_index + ' on this page; call list_flight_results again.');
    const pm = /\$([\d,]+(?:\.\d\d)?)/.exec(text(tile.querySelector('[data-testid="regular-price"], .price-line')));
    const price = pm ? Number(pm[1].replace(/,/g, '')) : null;
    if (price === null) return out('not_found', 'That fare shows no price (sold out or unavailable).');
    if (Math.abs(price - Number(input.expected_price)) > 0.005) return out('price_changed', 'Displayed price is $' + price + ', not $' + input.expected_price + '. Nothing was clicked.', { displayed_price: price });
    const mainText = () => text(document.querySelector('main'));
    const before = mainText().slice(0, 400);
    tile.click();
    const until = Date.now() + 6000;
    let state = null;
    while (Date.now() < until) {
      await sleep(300);
      const o = open();
      if (o) { state = o; break; }
      const other = [...document.querySelectorAll('fs-auro-dialog[open]')].find((x) => x.id !== 'saver-upsell-dialog' && x.id !== 'refundable-upsell-modal' && text(x));
      if (other) return out('other_dialog_open', 'Alaska opened another dialog (' + (other.id || 'unnamed') + ') that no tool answers; show its text to the user and let them decide in the browser.', { displayed_price: price, offer_summary: text(other).slice(0, 900) });
      const t = mainText();
      if (/Trip summary Clear all selections/.test(t)) { state = 'summary'; break; }
      if (t.slice(0, 400) !== before && /Depart: [A-Z]{3}.[A-Z]{3}/.test(t)) { state = 'return'; break; }
    }
    if (state === 'saver_restrictions' || state === 'refundable_upsell') {
      await sleep(300);
      const d = document.querySelector(state === 'saver_restrictions' ? '#saver-upsell-dialog' : '#refundable-upsell-modal');
      const restrictions = state === 'saver_restrictions' ? [...new Set([...d.querySelectorAll('li, [class*="row"], p')].map(text).filter((s) => s.length > 40 && /Saver|carry-on|refund|cancel|seat|points|boarding/i.test(s)))].slice(0, 12) : [];
      return out('offer_open', state === 'saver_restrictions' ? 'Alaska shows Saver restrictions and offers Main. Review them with the user, then call respond_fare_offer with continue_saver (user agrees) or upgrade_to_main.' : 'Alaska offers to make the itinerary refundable. Call respond_fare_offer with decline_refundable or make_refundable.', { open_offer: state, displayed_price: price, offer_summary: text(d).slice(0, 900), restrictions });
    }
    if (state === 'summary') return out('trip_summary_shown', 'Fare chosen; Alaska shows the trip summary. Use get_trip_summary, then continue_checkout.', { displayed_price: price });
    if (state === 'return') return out('return_flights_shown', 'Fare chosen; Alaska now lists return flights. Call list_flight_results again (indexes changed).', { displayed_price: price });
    return out('no_change', 'Clicked the fare but the page did not change within 6 s; call get_page_context before trying again.', { displayed_price: price });
  }
}]
