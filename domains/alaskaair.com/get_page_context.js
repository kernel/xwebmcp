[{
  kind: 'page',
  match: { url_patterns: ['https://alaskaair.com/*', 'https://*.alaskaair.com/*'] },
  tool: {
    name: 'get_page_context',
    description: 'Describe the current alaskaair.com page so you can decide what to do next: page type (home, sign-in, flight results for the departing or returning leg, the in-page trip summary after both flights are chosen, cart, checkout Travelers, Seats, Review & pay, other), which fare offer dialog is open (Saver restrictions or refundable upsell), whether it is still loading, whether the header shows a signed-in profile, the cart session time left, the WebMCP tools the page exposes and suggested next steps. Read-only; never returns names, account numbers or traveler details. Pass wait_for_settled_seconds after any step that navigates.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { wait_for_settled_seconds: { type: 'integer', minimum: 0, maximum: 30, default: 0 } }
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['current_path', 'page_type', 'unsettled', 'open_offer', 'signed_in', 'session_time_left', 'available_tools', 'suggested_next_steps'],
      properties: {
        current_path: { type: 'string' },
        page_type: { enum: ['home', 'sign_in', 'flight_results_departing', 'flight_results_returning', 'flight_trip_summary', 'cart', 'checkout_travelers', 'checkout_seats', 'checkout_review_and_pay', 'confirmation', 'other'] },
        unsettled: { type: 'boolean' },
        open_offer: { type: ['string', 'null'], enum: ['saver_restrictions', 'refundable_upsell', 'other_dialog', null], description: 'Fare dialog waiting for a choice; respond_fare_offer answers the first two, other_dialog (for example Alaska moving Saver flights to Main) is the user\'s to answer in the browser.' },
        signed_in: { type: ['boolean', 'null'], description: 'Null when the page has no Alaska header (for example the sign-in page).' },
        verification_or_challenge: { type: 'boolean' },
        session_time_left: { type: ['string', 'null'], description: 'Cart hold countdown, e.g. 00:09:52, when shown.' },
        available_tools: { type: ['array', 'null'], items: { type: 'string' } },
        suggested_next_steps: { type: 'array', items: { type: 'string' } }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wait = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
    const path = location.pathname;
    const isResults = /^\/search\/results/.test(path);
    const stored = () => { try { return JSON.parse(sessionStorage.getItem('xwebmcp_alaska_pending') || 'null'); } catch { return null; } };
    const pending = () => [globalThis.__xwebmcpAlaskaPending, stored()].some((p) => !!p && p.from === location.pathname && Date.now() - p.at < 30000);
    { const s = stored(); if (s && (s.from !== location.pathname || Date.now() - s.at >= 30000)) try { sessionStorage.removeItem('xwebmcp_alaska_pending'); } catch { /* ignore */ } }
    const bookReady = () => !/^\/book\//.test(path) || (!!document.querySelector('[data-testid="breadcrumb-bar"]') && /Total \$\d/.test(text(document.body)) && (!/seat-selection/.test(path) || !!document.querySelector('button.seat:not(.legend-seat)')) && (!/checkout/.test(path) || !!document.getElementById('TripInsurance_AWP0') || !/Protect your trip/.test(text(document.body))));
    const loading = () => pending() || !bookReady() || document.readyState !== 'complete' || (isResults && !document.querySelector('[data-testid^="valuetile-"]') && !/Trip summary/.test(text(document.querySelector('main'))) && !/no flights|no results/i.test(text(document.querySelector('main')))) || (/^\/book\//.test(path) && !document.querySelector('main'));
    const until = Date.now() + wait * 1000;
    while (wait && loading() && Date.now() < until) await sleep(300);
    const unsettled = loading();
    if (pending()) return { current_path: path, page_type: 'other', unsettled: true, open_offer: null, signed_in: null, verification_or_challenge: false, session_time_left: null, available_tools: null, suggested_next_steps: ['A continue_checkout click was just scheduled and this page has not navigated yet: wait, then call get_page_context again (list tools again once the page changes)'] };
    const host = location.hostname;
    const main = text(document.querySelector('main') || document.body);
    const openDialog = (id) => !!document.querySelector('fs-auro-dialog#' + id + '[open]');
    let pageType = 'other';
    if (host === 'auth0.alaskaair.com') pageType = 'sign_in';
    else if (path === '/' || /^\/(en|en-us)\/?$/.test(path)) pageType = 'home';
    else if (isResults) pageType = /^Change your search Trip summary|\bTrip summary Clear all selections/.test(main) ? 'flight_trip_summary' : /Depart: [A-Z]{3}.[A-Z]{3}/.test(main) ? 'flight_results_returning' : 'flight_results_departing';
    else if (/^\/search\/cart/.test(path)) pageType = 'cart';
    else if (/^\/book\/guest-info/.test(path)) pageType = 'checkout_travelers';
    else if (/^\/book\/seat-selection/.test(path)) pageType = 'checkout_seats';
    else if (/^\/book\/checkout/.test(path)) pageType = 'checkout_review_and_pay';
    else if (/^\/book\/confirmation/.test(path)) pageType = 'confirmation';
    const otherDialog = [...document.querySelectorAll('fs-auro-dialog[open]')].find((d) => d.id !== 'refundable-upsell-modal' && d.id !== 'saver-upsell-dialog' && text(d));
    const offer = openDialog('refundable-upsell-modal') ? 'refundable_upsell' : openDialog('saver-upsell-dialog') ? 'saver_restrictions' : otherDialog ? 'other_dialog' : null;
    let signedIn = null;
    const hdr = document.querySelector('borealis-header');
    if (hdr) {
      const deep = (root, acc = []) => { root.querySelectorAll('a, button').forEach((e) => acc.push(e)); root.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, acc)); return acc; };
      signedIn = !deep(hdr.shadowRoot || hdr).concat(deep(hdr)).some((e) => /^sign in$/i.test(text(e)) && /login/i.test(e.getAttribute('href') || ''));
    }
    const challenge = pageType === 'sign_in' && ([...document.querySelectorAll('.ulp-captcha iframe, iframe[src*="bframe"]')].some((f) => f.checkVisibility && f.checkVisibility({ visibilityProperty: true }) && f.getBoundingClientRect().bottom > 0) || [...document.querySelectorAll('input')].some((e) => e.autocomplete === 'one-time-code'));
    const session = (/Session expires in (\d\d:\d\d:\d\d)/.exec(main) || [])[1] || null;
    let tools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc?.getTools) tools = [...new Set((await mc.getTools()).map((t) => String(t?.name ?? t).split('.').pop()))].sort();
    } catch { tools = null; }
    const steps = [];
    if (unsettled) steps.push('The page is still loading: call get_page_context with wait_for_settled_seconds before acting');
    if (pageType === 'sign_in') steps.push(challenge ? 'Alaska shows a CAPTCHA or code step: ask the user to complete it in this tab (a code can go to login mode "otp"); do not press Sign in for them' : 'Use login with the credentials the user provided');
    if (signedIn === false && ['home', 'other', 'flight_results_departing'].includes(pageType)) steps.push('Use login (user-supplied credentials) first so saved traveler details and payment methods are available');
    if (['home', 'other'].includes(pageType)) steps.push('Use search_flights with origin, destination, dates and trip type');
    if (offer === 'saver_restrictions') steps.push('A Saver restrictions dialog is open: show the user its restrictions (from respond_fare_offer\'s preview or select_fare\'s output) and answer with respond_fare_offer (continue_saver needs the user\'s agreement, or upgrade_to_main)');
    if (offer === 'refundable_upsell') steps.push('A refundable-itinerary upsell is open: answer it with respond_fare_offer (decline_refundable, or make_refundable with its price)');
    if (offer === 'other_dialog') steps.push('Alaska shows another dialog: ' + text(otherDialog).slice(0, 300) + ' No tool answers it; show it to the user and let them choose in the browser before doing anything else');
    if (!offer && /^flight_results_/.test(pageType)) steps.push('Use list_flight_results to read the ' + (pageType === 'flight_results_returning' ? 'return' : 'departing') + ' flights, then select_fare with a result_index, fare and expected_price');
    if (pageType === 'flight_trip_summary' || pageType === 'cart') steps.push('Use get_trip_summary to confirm flights and total with the user, then continue_checkout with the expected total');
    if (/^checkout_/.test(pageType)) steps.push('Use get_checkout_step and get_trip_summary; checkout tools: list_seat_map/select_seat (Seats), set_trip_protection and list_payment_methods/select_payment_method (Review & pay), continue_checkout to move on. Traveler details, card numbers and "Book now" are the user\'s: no tool types or presses them');
    if (session) steps.push('Alaska holds this cart for ' + session + '; if it expires, search again');
    return { current_path: path, page_type: pageType, unsettled, open_offer: offer, signed_in: signedIn, verification_or_challenge: !!challenge, session_time_left: session, available_tools: tools, suggested_next_steps: steps };
  }
}]
