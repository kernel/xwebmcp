[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'continue_checkout',
    description: 'Press Alaska\'s forward button for the current booking step after checking the total the user agreed to: "Add to cart" on the results trip summary, "Continue to checkout" on the cart, "Continue" on Travelers (only when no required field is empty; saved profile details are used as Alaska prefilled them), and on Seats "Skip seats", "Next Flight" or "Save and continue" (seats_action). Never acts on Review & pay: "Book now" is the user\'s. The click is scheduled after this tool returns, so the outcome is NOT confirmed: call get_page_context with wait_for_settled_seconds, then list tools again (the document may change). After Travelers, poll get_checkout_step until the step changes: Alaska can look settled on Travelers for a few seconds.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['expected_total'],
      properties: {
        expected_total: { type: 'number', exclusiveMinimum: 0, description: 'Total the page shows now (per person on the results summary, whole booking elsewhere), from get_trip_summary or get_checkout_step.' },
        seats_action: { enum: ['skip_seats', 'next_flight', 'save_and_continue'], description: 'Required on the Seats step.' }
      }
    },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['status', 'navigation_scheduled', 'button', 'message'],
      properties: {
        status: { enum: ['scheduled', 'total_mismatch', 'missing_required_fields', 'not_allowed', 'button_missing', 'invalid_input', 'wrong_page'] },
        navigation_scheduled: { type: 'boolean' },
        button: { type: ['string', 'null'] },
        shown_total: { type: ['number', 'null'] },
        empty_required_fields: { type: 'array', items: { type: 'string' } },
        message: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const out = (status, message, extra = {}) => ({ status, navigation_scheduled: false, button: null, shown_total: null, empty_required_fields: [], message, ...extra });
    const expected = Number(input?.expected_total);
    if (!(expected > 0)) return out('invalid_input', 'expected_total is required; nothing was clicked.');
    if (location.hostname !== 'www.alaskaair.com') return out('wrong_page', 'Not on www.alaskaair.com.');
    const path = location.pathname;
    const main = text(document.querySelector('main') || document.body);
    // Totals can sit in a footer bar outside <main> (Seats step).
    const totalOf = (re) => { const all = [...text(document.body).matchAll(re)]; return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null; };
    let step = null;
    let shown = null;
    if (/^\/search\/results/.test(path) && /Trip summary Clear all selections/.test(main)) { step = 'summary'; shown = totalOf(/Total: \$([\d,]+(?:\.\d\d)?)/g); }
    else if (/^\/search\/cart/.test(path)) { step = 'cart'; shown = totalOf(/Total price \$([\d,]+\.\d\d)/g); }
    else if (/^\/book\/guest-info/.test(path)) { step = 'travelers'; shown = totalOf(/Total \$([\d,]+\.\d\d)/g); }
    else if (/^\/book\/seat-selection/.test(path)) { step = 'seats'; shown = totalOf(/Total \$([\d,]+\.\d\d)/g); }
    else if (/^\/book\/(checkout|confirmation)/.test(path)) return out('not_allowed', 'This is Review & pay: the remaining button is "Book now", which purchases. Only the user may press it.');
    else return out('wrong_page', 'No Alaska booking step with a forward button here; use get_page_context.');
    if (shown === null || Math.abs(shown - expected) > 0.005) return out('total_mismatch', 'The page shows ' + (shown === null ? 'no total' : '$' + shown) + ', not $' + expected + '. Nothing was clicked; confirm the total with the user.', { shown_total: shown });
    if (step !== 'seats' && input.seats_action !== undefined) return out('invalid_input', 'seats_action only applies on the Seats step; nothing was clicked.', { shown_total: shown });
    if (step === 'travelers') {
      const empty = [];
      for (const h of document.querySelectorAll('mbx-auro-input[required], mbx-auro-select[required]')) {
        const f = h.shadowRoot?.querySelector('input, select') || h.querySelector('input, select');
        if (f && !f.value) empty.push((h.getAttribute('label') || (h.id || 'field').replace(/([A-Z])/g, ' $1').toLowerCase()).slice(0, 60));
      }
      if (empty.length) return out('missing_required_fields', 'Required fields are empty; the user must fill them. Nothing was clicked.', { shown_total: shown, empty_required_fields: empty });
    }
    const labels = { summary: /^Add to cart$/, cart: /^Continue to checkout$/, travelers: /^Continue$/ };
    let label = labels[step];
    if (step === 'seats') {
      const map = { skip_seats: /^Skip seats$/, next_flight: /^Next Flight$/, save_and_continue: /^Save and continue$/ };
      if (!map[input.seats_action]) return out('invalid_input', 'seats_action (skip_seats, next_flight or save_and_continue) is required on the Seats step; nothing was clicked.', { shown_total: shown });
      label = map[input.seats_action];
    }
    const button = [...document.querySelectorAll('fs-auro-button, auro-button, seatsui-auro-button, button')].find((b) => visible(b) && label.test(text(b)) && !b.closest('[aria-hidden="true"]'));
    if (!button) return out('button_missing', 'No visible "' + label.source.replace(/[\^$]/g, '') + '" button on this step.', { shown_total: shown });
    if (button.disabled || button.hasAttribute('disabled')) return out('button_missing', 'The button is disabled.', { shown_total: shown });
    const name = text(button);
    // get_page_context treats this document as navigating until the path changes or 30 s pass (Travelers may rewrite its query string first).
    // Kept in sessionStorage too: Travelers can replace its document on the same path before routing on.
    const mark = { from: location.pathname, at: Date.now() };
    globalThis.__xwebmcpAlaskaPending = mark;
    try { sessionStorage.setItem('xwebmcp_alaska_pending', JSON.stringify(mark)); } catch { /* storage unavailable */ }
    setTimeout(() => (button.shadowRoot?.querySelector('button') || button).click(), 100);
    const after = step === 'travelers' ? ' Travelers keeps its path for a few seconds while it saves: get_page_context may still show checkout_travelers as settled, so poll get_checkout_step until step is seats before acting.' : '';
    return out('scheduled', 'Scheduled one click on "' + name + '". The outcome is NOT confirmed: call get_page_context with wait_for_settled_seconds: 15, then list tools again.' + after, { navigation_scheduled: true, button: name, shown_total: shown });
  }
}]
