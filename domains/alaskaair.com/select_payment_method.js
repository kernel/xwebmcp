[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'select_payment_method',
    description: 'Choose how to pay on Alaska\'s Review & pay step without typing anything: credit_debit_card opens the card option (a saved card, when the account has one, is chosen by saved_card_last4; otherwise the empty card form is shown for the user to fill), or none returns to the method list ("Change payment method"). Checks the total before and after and that it did not change. Apple Pay and commercial accounts are listed by list_payment_methods but not selectable here. Never types card data, never presses "Book now", purchases nothing.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['method', 'expected_total'],
      properties: {
        method: { enum: ['credit_debit_card', 'none'] },
        saved_card_last4: { type: 'string', pattern: '^[0-9]{4}$', description: 'Pick this saved card (from list_payment_methods); only with credit_debit_card.' },
        expected_total: { type: 'number', exclusiveMinimum: 0 }
      }
    },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['status', 'selected', 'card_form_shown', 'total_before', 'total_after', 'message'],
      properties: {
        status: { enum: ['selected', 'already_selected', 'saved_card_not_found', 'total_mismatch', 'no_change', 'invalid_input', 'wrong_page'] },
        selected: { type: ['string', 'null'] },
        saved_card_last4: { type: ['string', 'null'] },
        card_form_shown: { type: 'boolean', description: 'The new-card fields are visible: the user must type the card themselves.' },
        total_before: { type: ['number', 'null'] },
        total_after: { type: ['number', 'null'] },
        message: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    const total = () => { const all = [...text(document.querySelector('main') || document.body).matchAll(/Total \$([\d,]+\.\d\d)/g)]; return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null; };
    const out = (status, message, extra = {}) => ({ status, selected: null, saved_card_last4: null, card_form_shown: false, total_before: null, total_after: null, message, ...extra });
    const method = input?.method;
    if (method !== 'credit_debit_card' && method !== 'none') return out('invalid_input', 'method must be credit_debit_card or none; nothing was clicked.');
    if (input.saved_card_last4 !== undefined && (method !== 'credit_debit_card' || !/^[0-9]{4}$/.test(input.saved_card_last4))) return out('invalid_input', 'saved_card_last4 needs four digits and method credit_debit_card; nothing was clicked.');
    if (!(Number(input.expected_total) > 0)) return out('invalid_input', 'expected_total is required; nothing was clicked.');
    if (location.hostname !== 'www.alaskaair.com' || !/^\/book\/checkout/.test(location.pathname)) return out('wrong_page', 'Not on Alaska\'s Review & pay step.');
    const before = total();
    if (before === null || Math.abs(before - Number(input.expected_total)) > 0.005) return out('total_mismatch', 'The page total is ' + (before === null ? 'missing' : '$' + before) + ', not $' + input.expected_total + '; nothing was clicked.', { total_before: before });
    const head = [...document.querySelectorAll('h2, h3')].find((h) => /^Pay with$/.test(text(h)));
    const area = () => head?.parentElement || document.body;
    const cardOpen = () => !!area().querySelector('#CreditCard, [data-testid="CreditCard-area"]');
    const formShown = () => [...document.querySelectorAll('[data-testid="prerendered-credit-card-form"], #number-container')].some((e) => e.getClientRects().length > 0);
    const selectedName = () => (cardOpen() ? 'credit_debit_card' : area().querySelector('#not-selected') ? 'none' : 'other');
    const waitFor = async (fn) => { for (let i = 0; i < 25 && !fn(); i++) await sleep(200); return fn(); };
    if (method === 'none') {
      if (selectedName() === 'none') return out('already_selected', 'No payment method is chosen; nothing was clicked.', { selected: 'none', total_before: before, total_after: before });
      const change = [...area().querySelectorAll('button')].find((b) => /Change payment method/.test(text(b)));
      if (!change) return out('no_change', 'No "Change payment method" button.', { selected: selectedName(), total_before: before, total_after: total() });
      change.click();
      const ok = await waitFor(() => selectedName() === 'none');
      return out(ok ? 'selected' : 'no_change', ok ? 'Back to the payment method list.' : 'Alaska kept the method.', { selected: selectedName(), total_before: before, total_after: total() });
    }
    if (!cardOpen()) {
      const b = [...area().querySelectorAll('button')].find((x) => /^Credit\/debit card/.test(text(x)) && !/Change payment method/.test(text(x)));
      if (!b) return out('no_change', 'Alaska offers no credit/debit card option here.', { selected: selectedName(), total_before: before, total_after: total() });
      b.click();
      await waitFor(cardOpen);
    }
    let last4 = null;
    if (input.saved_card_last4) {
      const opt = [...area().querySelectorAll('input[type="radio"], [role="radio"], button')].find((e) => new RegExp('(?:ending in|\\*{2,}|•{2,}|x{2,})\\s*' + input.saved_card_last4 + '\\b', 'i').test(text(e.closest('label') || e.parentElement || e)));
      if (!opt) return out('saved_card_not_found', 'No saved card ending ' + input.saved_card_last4 + ' is shown' + (formShown() ? '; only the empty card form is available, for the user to fill' : '') + '.', { selected: selectedName(), card_form_shown: formShown(), total_before: before, total_after: total() });
      if (!(opt.checked || opt.getAttribute('aria-checked') === 'true')) opt.click();
      await sleep(800);
      last4 = input.saved_card_last4;
    }
    await sleep(300);
    const after = total();
    if (after !== before) return out('no_change', 'The total changed from $' + before + ' to $' + after + ' after choosing the method; tell the user before continuing.', { selected: selectedName(), saved_card_last4: last4, card_form_shown: formShown(), total_before: before, total_after: after });
    return out(cardOpen() ? 'selected' : 'no_change', cardOpen() ? (last4 ? 'Chose the saved card ending ' + last4 + '.' : 'Credit/debit card chosen; the card form is empty and must be filled by the user.') : 'Alaska did not open the card option.', { selected: selectedName(), saved_card_last4: last4, card_form_shown: formShown(), total_before: before, total_after: after });
  }
}]
