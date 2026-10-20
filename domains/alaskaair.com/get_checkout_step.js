[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'get_checkout_step',
    description: 'Report where an Alaska booking stands: the step (cart, travelers, seats, review_and_pay; from the progress bar), total due, labels of required traveler or contact fields that are still empty (labels only, never values), whether the saved traveler profile prefilled the form, the trip protection answer (unanswered, accepted, declined) with its premium, the payment method chosen and the tools for this step. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['status', 'step', 'total', 'empty_required_fields', 'trip_protection', 'payment_method', 'step_tools', 'message'],
      properties: {
        status: { enum: ['ok', 'not_ready', 'wrong_page'] },
        step: { type: ['string', 'null'], enum: ['cart', 'travelers', 'seats', 'review_and_pay', 'confirmation', null] },
        total: { type: ['number', 'null'] },
        empty_required_fields: { type: 'array', items: { type: 'string' } },
        traveler_count: { type: ['integer', 'null'] },
        seats_summary: { type: ['string', 'null'] },
        trip_protection: { type: ['object', 'null'], additionalProperties: false, properties: { answer: { enum: ['unanswered', 'accepted', 'declined'] }, premium: { type: ['number', 'null'] } } },
        payment_method: { type: ['string', 'null'], enum: ['none', 'credit_debit_card', 'apple_pay', 'commercial_account', 'other', null] },
        session_time_left: { type: ['string', 'null'] },
        step_tools: { type: 'array', items: { type: 'string' } },
        message: { type: ['string', 'null'] }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    const path = location.pathname;
    const base = { status: 'wrong_page', step: null, total: null, empty_required_fields: [], traveler_count: null, seats_summary: null, trip_protection: null, payment_method: null, session_time_left: null, step_tools: [], message: null };
    if (location.hostname !== 'www.alaskaair.com' || !(/^\/search\/cart/.test(path) || /^\/book\//.test(path))) return { ...base, message: 'Not on Alaska\'s cart or checkout; choose flights and use continue_checkout first.' };
    const main = text(document.querySelector('main') || document.body);
    const crumb = text(document.querySelector('[data-testid="breadcrumb-bar"] li[aria-current="step"]'));
    let step = /^\/search\/cart/.test(path) ? 'cart' : { Travelers: 'travelers', Seats: 'seats', 'Review & pay': 'review_and_pay', Confirmation: 'confirmation', Cart: 'cart' }[crumb] || null;
    if (!step) step = /guest-info/.test(path) ? 'travelers' : /seat-selection/.test(path) ? 'seats' : /checkout/.test(path) ? 'review_and_pay' : /confirmation/.test(path) ? 'confirmation' : null;
    const out = { ...base, status: 'ok', step };
    const totals = [...text(document.body).matchAll(/Total(?: price)? \$([\d,]+\.\d\d)/g)];
    out.total = totals.length ? Number(totals[totals.length - 1][1].replace(/,/g, '')) : null;
    out.session_time_left = (/Session expires in (\d\d:\d\d:\d\d)/.exec(main) || [])[1] || null;
    if (step === 'travelers') {
      const hosts = [...document.querySelectorAll('mbx-auro-input, mbx-auro-select')].filter((h) => h.hasAttribute('required') || h.querySelector?.('[required]') || h.shadowRoot?.querySelector('[required]'));
      for (const h of hosts) {
        const field = h.shadowRoot?.querySelector('input, select') || h.querySelector('input, select');
        if (field && !field.value) out.empty_required_fields.push((h.getAttribute('label') || (h.id || 'field').replace(/([A-Z])/g, ' $1').toLowerCase()).slice(0, 60));
      }
      out.traveler_count = document.querySelectorAll('mbx-auro-input[id="firstName"], mbx-auro-input[id^="firstName"]').length || null;
    }
    if (step === 'review_and_pay') {
      const yes = document.getElementById('TripInsurance_AWP0');
      const no = document.getElementById('TripInsurance_AWP1');
      if (yes || no) {
        const pm = /Add protection for \$([\d,]+\.\d\d)/.exec(main);
        out.trip_protection = { answer: yes?.checked ? 'accepted' : no?.checked ? 'declined' : 'unanswered', premium: pm ? Number(pm[1].replace(/,/g, '')) : null };
      }
      out.payment_method = document.querySelector('#CreditCard, [data-testid="CreditCard-area"]') ? 'credit_debit_card' : document.querySelector('#ApplePay, [data-testid="ApplePay-area"]') ? 'apple_pay' : document.querySelector('[data-testid*="Commercial"], #CommercialAccount') ? 'commercial_account' : document.querySelector('#not-selected') ? 'none' : 'other';
      const review = main.slice(Math.max(0, main.indexOf('Review your trip')));
      const s = / Seats (.{1,200}?) (?:Choose seats|Change seats|Edit seats|Travelers Edit)/.exec(review);
      out.seats_summary = s ? s[1].slice(0, 200) : null;
    }
    if (out.total === null || (step === 'review_and_pay' && !out.trip_protection && /Protect your trip/.test(main)) || (step === 'review_and_pay' && !document.getElementById('TripInsurance_AWP0') && !/Pay with/.test(main))) { out.status = 'not_ready'; out.message = 'This step is still loading; call get_checkout_step again in a few seconds.'; }
    out.step_tools = { cart: ['get_trip_summary', 'continue_checkout'], travelers: ['get_trip_summary', 'continue_checkout'], seats: ['list_seat_map', 'select_seat', 'continue_checkout', 'get_trip_summary'], review_and_pay: ['set_trip_protection', 'list_payment_methods', 'select_payment_method', 'get_trip_summary'], confirmation: [] }[step] || [];
    if (out.status === 'ok' && step === 'travelers' && out.empty_required_fields.length) out.message = 'Required traveler or contact fields are empty; the user must fill them (no tool types personal data).';
    if (out.status === 'ok' && step === 'review_and_pay') out.message = 'Final step: card details and "Book now" are the user\'s. No tool types card data or books.';
    return out;
  }
}]
