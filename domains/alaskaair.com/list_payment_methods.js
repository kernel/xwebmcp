[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'list_payment_methods',
    description: 'List the payment methods Alaska\'s Review & pay step offers (credit/debit card, Apple Pay, Alaska Airlines commercial account, gift certificate/card), which one is chosen, the accepted card brands and any cards saved to the signed-in account (brand and last four only). Read-only; never reads card fields. A signed-in account without saved cards shows only the new-card form.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['status', 'methods', 'selected', 'saved_cards', 'accepted_brands', 'total', 'message'],
      properties: {
        status: { enum: ['ok', 'wrong_page'] },
        methods: { type: 'array', items: { enum: ['credit_debit_card', 'apple_pay', 'commercial_account', 'gift_certificate'] } },
        selected: { type: ['string', 'null'], enum: ['none', 'credit_debit_card', 'apple_pay', 'commercial_account', 'other', null] },
        saved_cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['brand', 'last4', 'selected'], properties: { brand: { type: ['string', 'null'] }, last4: { type: 'string' }, selected: { type: 'boolean' } } } },
        accepted_brands: { type: 'array', items: { type: 'string' } },
        total: { type: ['number', 'null'] },
        message: { type: ['string', 'null'] }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    if (location.hostname !== 'www.alaskaair.com' || !/^\/book\/checkout/.test(location.pathname)) return { status: 'wrong_page', methods: [], selected: null, saved_cards: [], accepted_brands: [], total: null, message: 'Not on Alaska\'s Review & pay step.' };
    const head = [...document.querySelectorAll('h2, h3')].find((h) => /^Pay with$/.test(text(h)));
    const area = head?.parentElement || document.body;
    const t = text(area);
    const methods = [];
    if (/Credit\/debit card/.test(t)) methods.push('credit_debit_card');
    if (/Apple Pay/.test(t)) methods.push('apple_pay');
    if (/commercial account/i.test(t)) methods.push('commercial_account');
    if (/gift certificate/i.test(t)) methods.push('gift_certificate');
    const selected = area.querySelector('#CreditCard, [data-testid="CreditCard-area"]') ? 'credit_debit_card' : area.querySelector('#ApplePay, [data-testid="ApplePay-area"]') ? 'apple_pay' : area.querySelector('#CommercialAccount, [data-testid*="Commercial"]') ? 'commercial_account' : area.querySelector('#not-selected') ? 'none' : 'other';
    const brands = [...new Set([...area.querySelectorAll('[data-testid="accepted-card-logos"] [name^="cc-"]')].map((i) => i.getAttribute('name').slice(3)))];
    // Saved wallet cards are shown with a masked number; only brand and the last four digits are returned.
    const saved = [];
    for (const el of area.querySelectorAll('[data-testid*="saved"], [class*="saved-card"], [role="radio"], input[type="radio"]')) {
      const label = text(el.closest('label') || el.parentElement || el);
      const m = /(?:ending in|\*{2,}|•{2,}|x{2,})\s*(\d{4})\b/i.exec(label);
      if (!m) continue;
      const brand = (/(Visa|Mastercard|American Express|Amex|Discover|Diners|JCB|UnionPay|UATP)/i.exec(label) || [])[1] || null;
      if (!saved.some((s) => s.last4 === m[1] && s.brand === brand)) saved.push({ brand, last4: m[1], selected: !!(el.checked || el.getAttribute('aria-checked') === 'true') });
    }
    const all = [...text(document.querySelector('main') || document.body).matchAll(/Total \$([\d,]+\.\d\d)/g)];
    return { status: 'ok', methods, selected, saved_cards: saved, accepted_brands: brands, total: all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null, message: saved.length ? null : 'No saved cards are shown for this account; a card would have to be typed by the user.' };
  }
}]
