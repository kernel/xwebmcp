import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { El, h, makeDocument, runPageTool } from './alaskaair-fake-dom.mjs';

const src = (name) => readFileSync(new URL(`../domains/alaskaair.com/${name}.js`, import.meta.url), 'utf8');
const RESULTS = 'https://www.alaskaair.com/search/results?O=SEA&D=SFO&OD=2026-11-10&A=1&RT=true&DD=2026-11-13';
const PAGE_TOOLS = ['get_page_context', 'list_flight_results', 'select_fare', 'respond_fare_offer', 'get_trip_summary', 'get_checkout_step', 'continue_checkout', 'list_seat_map', 'select_seat', 'set_trip_protection', 'list_payment_methods', 'select_payment_method'];

function tile(row, col, fare, price, note = '') {
  return h('button', { attrs: { 'data-testid': `valuetile-${row}-${col}` }, cls: fare.toLowerCase() },
    h('span', { cls: 'cos-primary', text: fare }), h('p', { attrs: { 'data-testid': 'regular-price' }, cls: 'price-line', text: `$${price}` }), h('div', { text: 'Round trip' + (note ? ' ' + note : '') }));
}
function card(row, flight, dep, arr, prices) {
  const c = h('div', { cls: 'flight-card-container' },
    h('span', { cls: 'flight-number', text: flight }), h('span', { cls: 'duration', text: '2h 21m' }),
    h('span', { attrs: { 'data-testid': 'departure-time' }, text: dep }), h('span', { cls: 'airport-code', text: 'SEA' }),
    h('div', { attrs: { part: 'stop-label' }, text: 'Nonstop' }),
    h('span', { attrs: { 'data-testid': 'arrival-time' }, text: arr }), h('span', { cls: 'airport-code', text: 'SFO' }));
  ['Saver', 'Main', 'Premium', 'First'].forEach((f, i) => prices[i] && c.append(tile(row, i, f, prices[i], i === 3 ? 'Recliner last 6 seats' : '')));
  return c;
}
function resultsPage({ returning = false } = {}) {
  const saverDialog = h('fs-auro-dialog', { id: 'saver-upsell-dialog' },
    h('p', { text: 'Travel your way in Main Main fare gives you more flexible ways to fly CURRENTLY SELECTED Saver Main +$95 USD' }),
    h('li', { text: 'Saver fares cannot choose seats. Seats will be assigned at check-in.' }),
    h('li', { text: 'Passengers are allowed one carry-on and one personal item. Overhead bin space is first-come, first-served.' }),
    h('fs-auro-button', { text: 'Continue with Saver' }), h('fs-auro-button', { text: 'Upgrade to Main' }));
  const refundable = h('fs-auro-dialog', { id: 'refundable-upsell-modal' }, h('p', { text: 'Make your complete itinerary refundable + $155 Refundable itinerary' }),
    h('fs-auro-button', { attrs: { 'data-testid': 'select-non-refundable' }, text: 'Continue with flights' }), h('fs-auro-button', { attrs: { 'data-testid': 'select-refundable' }, text: 'Make it refundable' }));
  const head = h('div', { text: returning ? 'Change your search Depart: SEA–SFO Tuesday, November 10th Return' : 'Change your search Depart Mon, Nov 9th' });
  const main = h('main', {}, head, h('p', { text: 'All fares are round-trip per passenger, including taxes and fees.' }),
    card(0, 'AS 528', '8:54 am', '11:15 am', [207, 302, 393, 542]), card(1, 'AS 655', '11:43 am', '2:10 pm', [202, 297, 382, 537]), saverDialog, refundable);
  return { doc: makeDocument(h('body', {}, h('borealis-header', {}, h('a', { attrs: { href: '/account/login' }, text: 'Sign in' })), main)), main, head, saverDialog, refundable };
}

test('every page tool is a single self-contained page definition with typed schemas', async () => {
  for (const name of PAGE_TOOLS) {
    const { defs } = await runPageTool(src(name), { url: 'https://www.alaskaair.com/content/x', document: makeDocument(h('body', {})) }).catch(() => ({ defs: null }));
    const d = defs || (await import('node:vm')).runInNewContext('(' + src(name) + ')', {});
    assert.equal(d.length, 1, name);
    assert.equal(d[0].kind, 'page', name);
    assert.equal(d[0].tool.name, name);
    assert.ok(d[0].tool.inputSchema && d[0].tool.outputSchema, name);
    assert.deepEqual(JSON.parse(JSON.stringify(d[0].match.url_patterns)), ['https://alaskaair.com/*', 'https://*.alaskaair.com/*']);
    assert.doesNotMatch(src(name), /\bfetch\(|Book now'\)\.click|requestSubmit/, name);
  }
});

test('page tools refuse unrelated pages without acting', async () => {
  const doc = makeDocument(h('body', {}, h('main', { text: 'Travel info' })));
  const url = 'https://www.alaskaair.com/content/travel-info';
  for (const [name, input] of [['list_flight_results', {}], ['select_fare', { result_index: 0, fare: 'Saver', expected_price: 1 }], ['get_trip_summary', {}], ['get_checkout_step', {}], ['continue_checkout', { expected_total: 1 }], ['list_seat_map', {}], ['select_seat', { seat: '1A', max_price: 0 }], ['set_trip_protection', { choice: 'decline' }], ['list_payment_methods', {}], ['select_payment_method', { method: 'none', expected_total: 1 }]]) {
    const { result, timers } = await runPageTool(src(name), { url, document: doc, input });
    assert.equal(result.status, 'wrong_page', name);
    assert.equal(timers.length, 0, name);
  }
});

test('get_page_context classifies results, offers and sign-in state', async () => {
  const p = resultsPage({ returning: true });
  p.saverDialog.setAttribute('open', '');
  const { result } = await runPageTool(src('get_page_context'), { url: RESULTS, document: p.doc });
  assert.equal(result.page_type, 'flight_results_returning');
  assert.equal(result.open_offer, 'saver_restrictions');
  assert.equal(result.signed_in, false);
  assert.ok(result.suggested_next_steps.some((s) => /respond_fare_offer/.test(s)));
});

test('list_flight_results reads rows and fare columns', async () => {
  const { result } = await runPageTool(src('list_flight_results'), { url: RESULTS, document: resultsPage().doc });
  assert.equal(result.status, 'ok');
  assert.equal(result.leg, 'departing');
  assert.equal(result.flights.length, 2);
  assert.deepEqual(result.flights[0].flight_numbers, ['AS 528']);
  assert.equal(result.flights[0].departure_airport, 'SEA');
  assert.deepEqual(result.flights[0].fares.map((f) => [f.fare, f.price]), [['Saver', 207], ['Main', 302], ['Premium', 393], ['First', 542]]);
  assert.match(result.flights[0].fares[3].note, /last 6 seats/);
});

test('select_fare checks price, then reports the Saver restrictions dialog', async () => {
  const p = resultsPage();
  let r = await runPageTool(src('select_fare'), { url: RESULTS, document: p.doc, input: { result_index: 0, fare: 'Saver', expected_price: 199 } });
  assert.equal(r.result.status, 'price_changed');
  const t = p.doc.querySelector('[data-testid="valuetile-0-0"]');
  assert.equal(t.clicks, 0);
  t.onClick = () => p.saverDialog.setAttribute('open', '');
  r = await runPageTool(src('select_fare'), { url: RESULTS, document: p.doc, input: { result_index: 0, fare: 'Saver', expected_price: 207 } });
  assert.equal(r.result.status, 'offer_open');
  assert.equal(r.result.open_offer, 'saver_restrictions');
  assert.ok(r.result.restrictions.some((s) => /cannot choose seats/.test(s)));
  assert.ok(r.result.restrictions.some((s) => /carry-on/.test(s)));
  r = await runPageTool(src('select_fare'), { url: RESULTS, document: p.doc, input: { result_index: 0, fare: 'Main', expected_price: 302 } });
  assert.equal(r.result.status, 'offer_open', 'refuses while a dialog is open');
  assert.equal(p.doc.querySelector('[data-testid="valuetile-0-1"]').clicks, 0);
});

test('respond_fare_offer needs agreement and matching prices', async () => {
  const p = resultsPage();
  p.saverDialog.setAttribute('open', '');
  const cont = p.saverDialog.querySelector('fs-auro-button');
  cont.onClick = () => { p.saverDialog.removeAttribute('open'); p.head.ownText = 'Change your search Depart: SEA–SFO Tuesday Return'; };
  let r = await runPageTool(src('respond_fare_offer'), { url: RESULTS, document: p.doc, input: { choice: 'continue_saver' } });
  assert.equal(r.result.status, 'invalid_input');
  r = await runPageTool(src('respond_fare_offer'), { url: RESULTS, document: p.doc, input: { choice: 'upgrade_to_main', expected_price: 50 } });
  assert.equal(r.result.status, 'price_changed');
  assert.equal(r.result.shown_price, 95);
  r = await runPageTool(src('respond_fare_offer'), { url: RESULTS, document: p.doc, input: { choice: 'decline_refundable' } });
  assert.equal(r.result.status, 'no_offer_open');
  r = await runPageTool(src('respond_fare_offer'), { url: RESULTS, document: p.doc, input: { choice: 'continue_saver', accept_saver_restrictions: true } });
  assert.equal(r.result.status, 'done');
  assert.equal(r.result.next, 'return_flights');
  assert.equal(cont.clicks, 1);
});

function cartPage() {
  return makeDocument(h('body', {}, h('main', { text: "Rafael's cart Session expires in 00:09:52 Departing: Seattle, WA (SEA) to San Francisco, CA (SFO) Tuesday, November 10 AS 528 | Saver (X) | Operated by Alaska Details Seats Returning: San Francisco, CA (SFO) to Seattle, WA (SEA) Friday, November 13 AS 580 | Saver (X) | Operated by Alaska Details Seats Fare rules This ticket is nonrefundable. View all fare rules Change and cancellation policy You may cancel within 24 hours. Baggage policy When traveling Price summary Airfare $206.80 Standard fare, taxes, fees and charges United States Flight Segment Tax Domestic $10.60 US Sept. 11 security fee $11.20 Passengers x1 Total price $206.80" },
    h('fs-auro-button', { text: 'Continue to checkout' }))));
}

test('get_trip_summary reads the cart without traveler names', async () => {
  const { result } = await runPageTool(src('get_trip_summary'), { url: 'https://www.alaskaair.com/search/cart?A=1', document: cartPage() });
  assert.equal(result.page, 'cart');
  assert.deepEqual(result.slices, [{ from: 'SEA', to: 'SFO', date: 'Tuesday, November 10' }, { from: 'SFO', to: 'SEA', date: 'Friday, November 13' }]);
  assert.deepEqual(result.segments.map((s) => [s.flight, s.fare, s.booking_class]), [['AS 528', 'Saver', 'X'], ['AS 580', 'Saver', 'X']]);
  assert.deepEqual(result.price_lines, [{ label: 'Airfare', amount: 206.8 }]);
  assert.equal(result.included_taxes_and_fees.length, 2);
  assert.equal(result.total, 206.8);
  assert.equal(result.passengers, 1);
  assert.equal(result.session_time_left, '00:09:52');
  assert.equal(result.fare_notes.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /Rafael/);
});

test('continue_checkout checks the total and only schedules the click', async () => {
  const doc = cartPage();
  const btn = doc.querySelector('fs-auro-button');
  let r = await runPageTool(src('continue_checkout'), { url: 'https://www.alaskaair.com/search/cart?A=1', document: doc, input: { expected_total: 200 } });
  assert.equal(r.result.status, 'total_mismatch');
  assert.equal(r.timers.length, 0);
  r = await runPageTool(src('continue_checkout'), { url: 'https://www.alaskaair.com/search/cart?A=1', document: doc, input: { expected_total: 206.8 } });
  assert.equal(r.result.status, 'scheduled');
  assert.equal(r.result.navigation_scheduled, true);
  assert.equal(btn.clicks, 0, 'click happens only after the tool settles');
  r.timers[0]();
  assert.equal(btn.clicks, 1);
});

test('continue_checkout never acts on Review & pay and requires filled traveler fields', async () => {
  const pay = makeDocument(h('body', {}, h('main', { text: 'Review your trip Total $206.80' }, h('auro-button', { text: 'Book now' }))));
  let r = await runPageTool(src('continue_checkout'), { url: 'https://www.alaskaair.com/book/checkout', document: pay, input: { expected_total: 206.8 } });
  assert.equal(r.result.status, 'not_allowed');
  assert.equal(r.timers.length, 0);
  const input = h('input', { value: '' });
  const travelers = makeDocument(h('body', {}, h('main', { text: 'Enter your information Total $206.80' }, h('mbx-auro-input', { id: 'phone', attrs: { required: '' }, children: [input] }), h('auro-button', { text: 'Continue' }))));
  r = await runPageTool(src('continue_checkout'), { url: 'https://www.alaskaair.com/book/guest-info', document: travelers, input: { expected_total: 206.8 } });
  assert.equal(r.result.status, 'missing_required_fields');
  assert.deepEqual(r.result.empty_required_fields, ['phone']);
  input.value = 'x';
  r = await runPageTool(src('continue_checkout'), { url: 'https://www.alaskaair.com/book/guest-info', document: travelers, input: { expected_total: 206.8 } });
  assert.equal(r.result.status, 'scheduled');
  assert.equal(r.result.button, 'Continue');
  r = await runPageTool(src('continue_checkout'), { url: 'https://www.alaskaair.com/book/guest-info', document: travelers, input: { expected_total: 206.8, seats_action: 'skip_seats' } });
  assert.equal(r.result.status, 'invalid_input');
});

function seatPage() {
  const traveler = h('button', { cls: 'seat seat-unselected seat-active legend-seat', attrs: { 'aria-label': 'Traveler named Pat Doe. No seat assigned.' } });
  const footer = h('div', { text: 'Total $206.80 Seats total $0' });
  const modal = h('seatsui-auro-dialog', { id: 'seat-selection-modal' });
  const clear = h('button', { cls: 'clear-selection', attrs: { 'aria-label': 'Clear seat selection' } });
  const assign = (seat, price) => { traveler.attrs['aria-label'] = `${seat}. Traveler named Pat Doe. Seat price is $${price} USD.`; footer.ownText = `Total $${(206.8 + price).toFixed(2)} Seats total $${price}`; };
  clear.onClick = () => { traveler.attrs['aria-label'] = 'Traveler named Pat Doe. No seat assigned.'; footer.ownText = 'Total $206.80 Seats total $0'; };
  const pref = h('button', { cls: 'seat seat-mainpreferred seat-unselected cabin-seat', attrs: { 'aria-label': '13F. Main Preferred seat. Window seat.' }, onClick: () => assign('13F', 64) });
  const main = h('button', { cls: 'seat seat-main seat-unselected cabin-seat', attrs: { 'aria-label': '22C. Main Cabin seat. Aisle seat.' }, onClick: () => { modal.children = []; modal.append(h('p', { text: "Standard seat selection isn't included in Saver fare. If you'd like to choose your seat, please select an upgrade. 22C Main Cabin" })); modal.append(h('seatsui-auro-button', { text: 'Return to seat selection', onClick: () => { modal.children = []; } })); } });
  const gone = h('button', { cls: 'seat seat-unavailable cabin-seat', attrs: { 'aria-label': '1A Unavailable.' } });
  const doc = makeDocument(h('body', {}, h('main', { text: 'Select seats AS 528 Operated by Alaska Tue, Nov 10 | Boeing 737-900 (Winglets) A C D F 1 Premium Class +$73 - $91 USD Main Preferred +$51 - $64 USD Main Cabin Wi-Fi available' }, traveler, pref, main, gone, clear, modal), footer));
  return { doc, traveler, pref, main };
}

test('list_seat_map reads seats, prices and travelers by index', async () => {
  const { result } = await runPageTool(src('list_seat_map'), { url: 'https://www.alaskaair.com/book/seat-selection', document: seatPage().doc });
  assert.equal(result.flight, 'AS 528');
  assert.deepEqual(result.seats.map((s) => [s.seat, s.type]), [['13F', 'main_preferred'], ['22C', 'main']]);
  assert.equal(result.total, 206.8);
  assert.deepEqual(result.travelers, [{ traveler_index: 0, seat: null, price: null, active: true }]);
  assert.doesNotMatch(JSON.stringify(result), /Pat Doe/);
});

test('select_seat enforces max_price, releases, and reports Saver refusals', async () => {
  const s = seatPage();
  const url = 'https://www.alaskaair.com/book/seat-selection';
  let r = await runPageTool(src('select_seat'), { url, document: s.doc, input: { seat: '13F', max_price: 30 } });
  assert.equal(r.result.status, 'price_too_high');
  assert.equal(r.result.total_after, 206.8, 'seat released again');
  r = await runPageTool(src('select_seat'), { url, document: s.doc, input: { seat: '13F', max_price: 64 } });
  assert.equal(r.result.status, 'selected');
  assert.equal(r.result.total_after, 270.8);
  r = await runPageTool(src('select_seat'), { url, document: s.doc, input: { release: true } });
  assert.equal(r.result.status, 'released');
  assert.equal(r.result.total_after, 206.8);
  r = await runPageTool(src('select_seat'), { url, document: s.doc, input: { seat: '22C', max_price: 0 } });
  assert.equal(r.result.status, 'not_included_in_fare');
  r = await runPageTool(src('select_seat'), { url, document: s.doc, input: { seat: '1A', max_price: 0 } });
  assert.equal(r.result.status, 'unavailable');
  r = await runPageTool(src('select_seat'), { url, document: s.doc, input: { seat: '13F' } });
  assert.equal(r.result.status, 'invalid_input');
});

function payPage() {
  const ps = h('div', { text: 'Price summary Airfare $206.80 Total $206.80' });
  const yes = new El('input', { id: 'TripInsurance_AWP0', checked: false });
  const no = new El('input', { id: 'TripInsurance_AWP1', checked: false });
  yes.onClick = () => { yes.checked = true; no.checked = false; ps.ownText = 'Price summary Airfare $206.80 Travel insurance $23.98 Total $230.78'; };
  no.onClick = () => { no.checked = true; yes.checked = false; ps.ownText = 'Price summary Airfare $206.80 Total $206.80'; };
  const area = h('div', {}, h('h2', { text: 'Pay with' }), h('button', { text: 'Add a gift certificate/card' }), h('div', { id: 'not-selected' }));
  const card = h('button', { text: 'Credit/debit card' });
  card.onClick = () => { area.querySelector('#not-selected').id = 'gone'; const cc = area.append(h('div', { id: 'CreditCard' }, h('div', { attrs: { 'data-testid': 'accepted-card-logos' } }, h('i', { attrs: { name: 'cc-visa' } })), h('button', { text: 'Change payment method', onClick: () => { area.children = area.children.filter((c) => c !== cc && c !== form); area.append(h('div', { id: 'not-selected' })); } }))); const form = area.append(h('div', { attrs: { 'data-testid': 'prerendered-credit-card-form' } })); };
  [card, h('button', { text: 'Apple Pay' }), h('button', { text: 'Alaska Airlines commercial account' })].forEach((b) => area.append(b));
  const doc = makeDocument(h('body', {}, h('main', { text: 'Review your trip Protect your trip Add protection for $23.98 total.' }, yes, no, area, ps, h('auro-button', { text: 'Book now' }))));
  return { doc, yes, no };
}

test('set_trip_protection checks the premium and verifies the total', async () => {
  const p = payPage();
  const url = 'https://www.alaskaair.com/book/checkout';
  let r = await runPageTool(src('set_trip_protection'), { url, document: p.doc, input: { choice: 'accept', expected_premium: 20 } });
  assert.equal(r.result.status, 'premium_changed');
  assert.equal(p.yes.clicks, 0);
  r = await runPageTool(src('set_trip_protection'), { url, document: p.doc, input: { choice: 'accept', expected_premium: 23.98 } });
  assert.equal(r.result.status, 'done');
  assert.equal(r.result.total_after, 230.78);
  r = await runPageTool(src('set_trip_protection'), { url, document: p.doc, input: { choice: 'decline' } });
  assert.deepEqual([r.result.status, r.result.answer, r.result.total_after], ['done', 'declined', 206.8]);
  r = await runPageTool(src('set_trip_protection'), { url, document: p.doc, input: { choice: 'decline' } });
  assert.equal(r.result.status, 'already_set');
  const { result } = await runPageTool(src('get_checkout_step'), { url, document: p.doc });
  assert.deepEqual(result.trip_protection, { answer: 'declined', premium: 23.98 });
});

test('payment tools list and choose methods without typing, and report missing saved cards', async () => {
  const p = payPage();
  const url = 'https://www.alaskaair.com/book/checkout';
  let r = await runPageTool(src('list_payment_methods'), { url, document: p.doc });
  assert.deepEqual(r.result.methods, ['credit_debit_card', 'apple_pay', 'commercial_account', 'gift_certificate']);
  assert.equal(r.result.selected, 'none');
  assert.deepEqual(r.result.saved_cards, []);
  r = await runPageTool(src('select_payment_method'), { url, document: p.doc, input: { method: 'credit_debit_card', expected_total: 1 } });
  assert.equal(r.result.status, 'total_mismatch');
  r = await runPageTool(src('select_payment_method'), { url, document: p.doc, input: { method: 'credit_debit_card', expected_total: 206.8 } });
  assert.deepEqual([r.result.status, r.result.selected, r.result.card_form_shown], ['selected', 'credit_debit_card', true]);
  r = await runPageTool(src('select_payment_method'), { url, document: p.doc, input: { method: 'credit_debit_card', saved_card_last4: '1234', expected_total: 206.8 } });
  assert.equal(r.result.status, 'saved_card_not_found');
  r = await runPageTool(src('select_payment_method'), { url, document: p.doc, input: { method: 'none', expected_total: 206.8 } });
  assert.deepEqual([r.result.status, r.result.selected], ['selected', 'none']);
  r = await runPageTool(src('select_payment_method'), { url, document: p.doc, input: { method: 'apple_pay', expected_total: 206.8 } });
  assert.equal(r.result.status, 'invalid_input');
});

test('readiness: scheduled navigation, empty seat map and unanswered dialogs are not reported as ready', async () => {
  const doc = cartPage();
  const pending = { __xwebmcpAlaskaPending: { from: '/search/cart', at: 1e12 } };
  let r = await runPageTool(src('get_page_context'), { url: 'https://www.alaskaair.com/search/cart?A=1', document: doc, extra: { globalThis: pending } });
  assert.equal(r.result.unsettled, true);
  assert.match(r.result.suggested_next_steps[0], /not navigated yet/);
  r = await runPageTool(src('list_seat_map'), { url: 'https://www.alaskaair.com/book/seat-selection', document: makeDocument(h('body', {}, h('main', { text: 'Select seats' }))) });
  assert.equal(r.result.status, 'not_ready');
  const p = resultsPage();
  const other = h('fs-auro-dialog', { id: 'saver-to-main-confirm-modal' }, h('p', { text: 'Upgrade both flights to Main?' }));
  p.main.append(other);
  p.doc.querySelector('[data-testid="valuetile-1-1"]').onClick = () => other.setAttribute('open', '');
  r = await runPageTool(src('select_fare'), { url: RESULTS, document: p.doc, input: { result_index: 1, fare: 'Main', expected_price: 297 } });
  assert.equal(r.result.status, 'other_dialog_open');
  assert.match(r.result.offer_summary, /Upgrade both/);
});

test('an unknown open dialog blocks select_fare and is surfaced by get_page_context', async () => {
  const p = resultsPage({ returning: true });
  p.main.append(h('fs-auro-dialog', { id: 'saver-to-main-confirm-modal', attrs: { open: '' } }, h('p', { text: 'Confirm your selection of Main cabin. +$75 USD' })));
  let r = await runPageTool(src('select_fare'), { url: RESULTS, document: p.doc, input: { result_index: 0, fare: 'Saver', expected_price: 207 } });
  assert.equal(r.result.status, 'other_dialog_open');
  assert.equal(p.doc.querySelector('[data-testid="valuetile-0-0"]').clicks, 0);
  r = await runPageTool(src('get_page_context'), { url: RESULTS, document: p.doc });
  assert.equal(r.result.open_offer, 'other_dialog');
  const pending = { __xwebmcpAlaskaPending: { from: '/book/guest-info', at: 1e12 } };
  r = await runPageTool(src('get_page_context'), { url: 'https://www.alaskaair.com/book/guest-info?changed=1', document: makeDocument(h('body', {})), extra: { globalThis: pending } });
  assert.equal(r.result.unsettled, true, 'pending mark matches by path');
});

test('pending navigation survives a same-path document replacement via sessionStorage', async () => {
  const store = new Map();
  const sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const input = h('input', { value: 'x' });
  const travelers = makeDocument(h('body', {}, h('main', { text: 'Enter your information Total $206.80' }, h('mbx-auro-input', { id: 'phone', attrs: { required: '' }, children: [input] }), h('auro-button', { text: 'Continue' }))));
  const url = 'https://www.alaskaair.com/book/guest-info';
  const r = await runPageTool(src('continue_checkout'), { url, document: travelers, input: { expected_total: 206.8 }, extra: { sessionStorage } });
  assert.equal(r.result.status, 'scheduled');
  const ctx = await runPageTool(src('get_page_context'), { url, document: travelers, extra: { sessionStorage } });
  assert.equal(ctx.result.unsettled, true);
  const later = await runPageTool(src('get_page_context'), { url: 'https://www.alaskaair.com/book/seat-selection', document: makeDocument(h('body', {})), extra: { sessionStorage } });
  assert.equal(store.size, 0, 'mark cleared once the path changed');
  void later;
});
