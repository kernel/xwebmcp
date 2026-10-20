[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'set_trip_protection',
    description: 'Answer Alaska\'s required "Protect your trip" question (Allianz travel insurance) on Review & pay: decline, or accept with expected_premium (the "$X total" Alaska quotes). Verifies the booking total after the change: accepting adds the premium as "Travel insurance", declining removes it. Alaska starts with no answer; once answered it can be switched but not cleared. Changes the cart only; nothing is purchased.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['choice'],
      properties: {
        choice: { enum: ['accept', 'decline'] },
        expected_premium: { type: 'number', exclusiveMinimum: 0, description: 'Required for accept.' }
      }
    },
    outputSchema: {
      type: 'object', additionalProperties: false, required: ['status', 'answer', 'premium', 'total_before', 'total_after', 'message'],
      properties: {
        status: { enum: ['done', 'already_set', 'premium_changed', 'not_offered', 'no_change', 'invalid_input', 'wrong_page'] },
        answer: { type: ['string', 'null'], enum: ['unanswered', 'accepted', 'declined', null] },
        premium: { type: ['number', 'null'] },
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
    const main = () => text(document.querySelector('main') || document.body);
    const total = () => { const all = [...main().matchAll(/Total \$([\d,]+\.\d\d)/g)]; return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null; };
    const out = (status, message, extra = {}) => ({ status, answer: null, premium: null, total_before: null, total_after: null, message, ...extra });
    const choice = input?.choice;
    if (choice !== 'accept' && choice !== 'decline') return out('invalid_input', 'choice must be accept or decline; nothing was clicked.');
    if (choice === 'accept' && !(Number(input.expected_premium) > 0)) return out('invalid_input', 'accept needs expected_premium; nothing was clicked.');
    if (choice === 'decline' && input.expected_premium !== undefined) return out('invalid_input', 'expected_premium only applies to accept; nothing was clicked.');
    if (location.hostname !== 'www.alaskaair.com' || !/^\/book\/checkout/.test(location.pathname)) return out('wrong_page', 'Not on Alaska\'s Review & pay step.');
    const yes = document.getElementById('TripInsurance_AWP0');
    const no = document.getElementById('TripInsurance_AWP1');
    if (!yes || !no) return out('not_offered', 'Alaska shows no trip protection question on this page.', { total_before: total(), total_after: total() });
    const answer = () => (yes.checked ? 'accepted' : no.checked ? 'declined' : 'unanswered');
    const pm = /Add protection for \$([\d,]+\.\d\d)/.exec(main());
    const premium = pm ? Number(pm[1].replace(/,/g, '')) : null;
    const before = total();
    const want = choice === 'accept' ? 'accepted' : 'declined';
    if (answer() === want) return out('already_set', 'Trip protection is already ' + want + '; nothing was clicked.', { answer: want, premium, total_before: before, total_after: before });
    if (choice === 'accept' && (premium === null || Math.abs(premium - Number(input.expected_premium)) > 0.005)) return out('premium_changed', 'Alaska quotes ' + (premium === null ? 'no premium' : '$' + premium) + ', not $' + input.expected_premium + '; nothing was clicked.', { answer: answer(), premium, total_before: before, total_after: before });
    const insuranceLine = () => /Travel insurance \$([\d,]+\.\d\d)/.test(main().slice(main().lastIndexOf('Price summary')));
    (choice === 'accept' ? yes : no).click();
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      if (answer() === want && insuranceLine() === (choice === 'accept')) break;
    }
    await sleep(300);
    const after = total();
    const ok = answer() === want && insuranceLine() === (choice === 'accept');
    return out(ok ? 'done' : 'no_change', ok ? 'Trip protection ' + want + '; total is now $' + after + '.' : 'Alaska did not confirm the change (answer ' + answer() + '); check get_trip_summary.', { answer: answer(), premium, total_before: before, total_after: after });
  }
}]
