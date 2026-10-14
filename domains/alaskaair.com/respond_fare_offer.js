[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'respond_fare_offer',
    description: 'Answer the fare dialog Alaska opened after select_fare. For the Saver restrictions dialog: continue_saver (only with the user\'s agreement to Saver\'s restrictions: no seat choice, last boarding, limited changes, 50% credit only when canceled 14+ days out) or upgrade_to_main (needs expected_price, the "+$" amount shown). For the refundable-itinerary upsell: decline_refundable, or make_refundable with expected_price. Same-document; purchases nothing. Reports what Alaska shows next (return flights, trip summary or another dialog).',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['choice'],
      properties: {
        choice: { enum: ['continue_saver', 'upgrade_to_main', 'decline_refundable', 'make_refundable'] },
        accept_saver_restrictions: { type: 'boolean', description: 'Must be true for continue_saver: the user agreed to Saver\'s restrictions.' },
        expected_price: { type: 'number', exclusiveMinimum: 0, description: 'Add-on price shown in the dialog; required for upgrade_to_main and make_refundable.' }
      }
    },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['status', 'next', 'message'],
      properties: {
        status: { enum: ['done', 'price_changed', 'no_offer_open', 'invalid_input', 'no_change'] },
        next: { type: ['string', 'null'], enum: ['saver_restrictions', 'refundable_upsell', 'return_flights', 'trip_summary', null] },
        shown_price: { type: ['number', 'null'] },
        message: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    const out = (status, message, next = null, shown_price = null) => ({ status, next, shown_price, message });
    const choice = input?.choice;
    const needsPrice = choice === 'upgrade_to_main' || choice === 'make_refundable';
    if (!['continue_saver', 'upgrade_to_main', 'decline_refundable', 'make_refundable'].includes(choice)) return out('invalid_input', 'Unknown choice; nothing was clicked.');
    if (choice === 'continue_saver' && input.accept_saver_restrictions !== true) return out('invalid_input', 'continue_saver needs accept_saver_restrictions: true (the user agreed to Saver\'s restrictions); nothing was clicked.');
    if (needsPrice && !(Number(input.expected_price) > 0)) return out('invalid_input', choice + ' needs expected_price; nothing was clicked.');
    const saver = choice === 'continue_saver' || choice === 'upgrade_to_main';
    const d = document.querySelector(saver ? 'fs-auro-dialog#saver-upsell-dialog[open]' : 'fs-auro-dialog#refundable-upsell-modal[open]');
    if (!d) return out('no_offer_open', 'The ' + (saver ? 'Saver restrictions' : 'refundable upsell') + ' dialog is not open; call get_page_context.');
    let button;
    let shown = null;
    if (saver) {
      button = [...d.querySelectorAll('fs-auro-button')].find((b) => (choice === 'continue_saver' ? /^Continue with Saver$/ : /^Upgrade to Main$/).test(text(b)));
      const m = /Main\s*\+\$([\d,]+(?:\.\d\d)?)/.exec(text(d));
      shown = m ? Number(m[1].replace(/,/g, '')) : null;
    } else {
      button = d.querySelector(choice === 'make_refundable' ? '[data-testid="select-refundable"]' : '[data-testid="select-non-refundable"]');
      const m = /\+\s*\$([\d,]+(?:\.\d\d)?)/.exec(text(d));
      shown = m ? Number(m[1].replace(/,/g, '')) : null;
    }
    if (!button) return out('no_change', 'The dialog has no button for ' + choice + '; nothing was clicked.', null, shown);
    if (needsPrice && (shown === null || Math.abs(shown - Number(input.expected_price)) > 0.005)) return out('price_changed', 'The dialog shows +$' + shown + ', not +$' + input.expected_price + '; nothing was clicked.', null, shown);
    // The leg/summary area outside the dialogs tells what Alaska shows next; the dialog's open attribute can linger.
    const legText = () => text(document.querySelector('main')).slice(0, 300);
    const before = legText();
    const shownDialog = (el) => !!el && el.hasAttribute('open') && el.getClientRects().length > 0 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }));
    (button.shadowRoot?.querySelector('button') || button).click();
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      await sleep(300);
      const ref = document.querySelector('fs-auro-dialog#refundable-upsell-modal');
      if (d.id !== 'refundable-upsell-modal' && shownDialog(ref)) return out('done', 'Alaska now offers a refundable itinerary; answer with respond_fare_offer.', 'refundable_upsell', shown);
      const t = text(document.querySelector('main'));
      if (/Trip summary Clear all selections/.test(t)) return out('done', 'Alaska shows the trip summary; use get_trip_summary, then continue_checkout.', 'trip_summary', shown);
      if (legText() !== before && /Depart: [A-Z]{3}.[A-Z]{3}/.test(t)) return out('done', 'Alaska lists return flights; call list_flight_results.', 'return_flights', shown);
    }
    return out(shownDialog(d) ? 'no_change' : 'done', shownDialog(d) ? 'The dialog stayed open; call get_page_context.' : 'Dialog closed; call get_page_context to see the next step.', null, shown);
  }
}]
