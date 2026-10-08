import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Document } from './etsy-dom.mjs';
const names=['continue_checkout','get_checkout_step','list_payment_methods','list_seat_map','open_seat_map','select_saved_payment_method','select_seat','set_trip_protection','skip_seat_selection'];
async function run(name,html,input={},path='/purchase/flights/review-pay',onClick=()=>{}) {
 const document=new Document(`<html><body>${html}</body></html>`); document.readyState='complete';
 const proto=Object.getPrototypeOf(document.body);
 Object.defineProperty(proto,'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(v){v?this.setAttribute('checked',''):this.removeAttribute('checked')}});
 Object.defineProperty(proto,'required',{configurable:true,get(){return this.hasAttribute('required')}});
 Object.defineProperty(proto,'isConnected',{configurable:true,get(){return document.body.contains(this)}});
 proto.click=function(){onClick(this,document)};
 const scheduled=[]; let now=0;
 class Clock extends Date { static now(){return now} }
 const context={document,location:{href:'https://www.delta.com'+path,hostname:'www.delta.com',pathname:path,search:''},URL,URLSearchParams,Date:Clock,
 getComputedStyle:()=>({visibility:'visible'}),setTimeout:(fn,ms)=>{if(ms===100)scheduled.push(fn);else {now+=ms;queueMicrotask(fn)}}, navigator:{},MutationObserver:class{observe(){}disconnect(){}}};
 const [def]=runInNewContext('('+readFileSync(new URL(`../domains/delta.com/${name}.js`,import.meta.url),'utf8')+')',context);
 const out=JSON.parse(JSON.stringify(await def.execute(input))); return {out,scheduled,document,def};
}
const total='<div class="mach-core-trip-total__details__footer__amount">$123.41 USD</div>';
const passenger='<div><idp-section-container><idp-section><div class="font-primary">Passenger Details</div></idp-section></idp-section-container><label for="first">First Name</label><input id="first" aria-required="true"><button data-cy="save-and-continue-passenger-button">Save &amp; Continue</button></div>';
test('new checkout tools declare snake_case typed contracts and reject unrelated pages',async()=>{
 for(const name of names){const {out,def}=await run(name,'',{},'/unrelated'); assert.ok(def.tool.inputSchema);assert.ok(def.tool.outputSchema);assert.notEqual(out.status,'selected');assert.notEqual(out.status,'continued');assert.notEqual(out.status,'navigation_scheduled');}
});
test('checkout reader describes active passenger section without disclosing field values',async()=>{
 const {out}=await run('get_checkout_step',total+'<header><button id="login-trigger">Log in</button></header>'+passenger);
 assert.equal(out.status,'ok');assert.equal(out.amount_due,123.41);assert.equal(out.active_section,'passenger_details');assert.deepEqual(out.missing_required_fields,['First Name']);assert.equal(out.signed_in,false);
});
test('continue requires confirmation and totals and refuses stale or empty fields',async()=>{
 const html=total+passenger;let clicks=0;const click=()=>clicks++;
 assert.equal((await run('continue_checkout',html,{confirm:false,from_step:'passenger_details',expected_total_due:123.41},undefined,click)).out.status,'not_confirmed');
 assert.equal((await run('continue_checkout',html,{confirm:true,from_step:'passenger_details'},undefined,click)).out.status,'error');
 assert.equal((await run('continue_checkout',html,{confirm:true,from_step:'passenger_details',expected_total_due:100},undefined,click)).out.status,'stale_state');
 assert.equal((await run('continue_checkout',html,{confirm:true,from_step:'passenger_details',expected_total_due:123.41},undefined,click)).out.status,'missing_required_fields'); assert.equal(clicks,0);
});
test('navigation is scheduled, not falsely confirmed, and never clicks final purchase',async()=>{
 const r=await run('continue_checkout',total+'<button data-cy="ts-save-continue-btn">Save &amp; Continue</button>',{confirm:true,from_step:'trip_summary',expected_total_due:123.41},'/purchase/flights/trip-summary');assert.equal(r.out.status,'navigation_scheduled');assert.equal(r.scheduled.length,1);
 let clicks=0; const f=await run('continue_checkout',total+'<button data-cy="complete-purchase-action-btn">Complete Purchase</button>',{confirm:true,from_step:'payment',expected_total_due:123.41},undefined,()=>clicks++);assert.equal(f.out.status,'final_step');assert.equal(clicks,0);
});
test('payment tools fail closed when signed out, never enter card data',async()=>{
 const html=total+'<header><button id="login-trigger">Log in</button></header>';
 assert.equal((await run('list_payment_methods',html)).out.status,'login_required');
 assert.equal((await run('select_saved_payment_method',html,{last4:'1234',confirm:true,expected_total_due:123.41})).out.status,'login_required');
});
test('trip protection requires confirmation, detects stale totals and sets decline',async()=>{
 const html=total+'<idp-display-trip-protection><label for="no">No, decline protection</label><input type="radio" id="no"><label for="yes">Yes, protect my trip</label><input type="radio" id="yes"></idp-display-trip-protection>';
 assert.equal((await run('set_trip_protection',html,{choice:'decline',confirm:false,expected_total_due:123.41})).out.status,'not_confirmed');
 assert.equal((await run('set_trip_protection',html,{choice:'decline',confirm:true,expected_total_due:10})).out.status,'stale_state');
 const r=await run('set_trip_protection',html,{choice:'decline',confirm:true,expected_total_due:123.41},undefined,(el,doc)=>{doc.getElementById(el.id).checked=true});assert.equal(r.out.status,'set');assert.equal(r.out.choice,'decline');
});
test('seat reader parses the current seat map markup without seat-element classes',async()=>{
 const sprite=s=>`style="background-image: url(sprite.svg#${s})"`;
 const html='<idp-seatmap-header><div class="mach-flight-list-header"><div class="mach-flight-list-header__airport-code"> ATL <span class="mach-flight-list-header__direction"></span> MCO </div><div class="mach-flight-list-header__travel-detail"><div><span>Atlanta, GA to Orlando, FL</span></div><div><span>Thu, Dec 3</span></div><div><span>DL1234 1h 30m</span></div><div><span>Airbus A321</span></div><div><span>1 of 2</span></div></div></div></idp-seatmap-header>'
  +'<button class="seat-key-legend__info-icon" id="seat-key-info-Icon"></button>'
  +`<button class="first brs" id="seat-1A" aria-label="1A, Delta First, available" ${sprite('BRS-FCAVS-available')}></button>`
  +`<button class="dcp srs aura-seat--label" id="seat-10C" aria-label="10C, Delta Comfort, unavailable" ${sprite('SRS-CPLAVS-selected')}>AB</button>`
  +`<button class="main srs" id="seat-15C" aria-label="15C, Delta Main - Preferred, available" ${sprite('SRS-PRFAVS-available')}></button>`
  +`<button class="main srs" id="seat-15D" aria-label="15D, Delta Main, unavailable" ${sprite('SRS-MCAVS-occupied')}></button>`
  +'<button id="cabinFIRST">First Additional Amount $284.88 this flight per passenger</button><button id="cabinDCP">Comfort Current Selection</button><button id="cabinMAIN">Main Additional Amount</button>'
  +'<div class="passenger-info"><div class="passenger-info__seat passenger-info__seat--selected">10C</div><div class="passenger-info__detail"><div class="passenger-info__detail--name">Test Traveler</div></div></div>';
 const {out}=await run('list_seat_map',html,{},'/seats/update');
 assert.equal(out.status,'ok');
 assert.deepEqual(out.flight,{origin:'ATL',destination:'MCO',flight_number:'DL1234',date_display:'Thu, Dec 3',aircraft:'Airbus A321',position_display:'1 of 2'});
 assert.deepEqual(out.seats.map(s=>[s.seat,s.cabin,s.seat_type,s.availability]),[['1A','first','first','available'],['10C','comfort','comfort','selected'],['15C','main','preferred','available']]);
 assert.deepEqual(out.cabins.map(c=>[c.code,c.selected,c.extra_amount]),[['FIRST',false,284.88],['DCP',true,null],['MAIN',false,null]]);
 assert.deepEqual(out.passengers,[{label:'Test Traveler',seat:'10C'}]);
 assert.equal((await run('list_seat_map',html,{availability:'all'},'/seats/update')).out.seat_count,4);
});
test('seat reader and chooser exercise available, occupied, unknown and already held seats',async()=>{
 const html='<button class="main seat-element" id="seat-22B" aria-label="Seat 22B Delta Main available" style="background-image: url(sprite#SRS-MCAVS-available)"></button><button class="main seat-element" id="seat-22A" aria-label="Seat 22A Delta Main occupied"></button><div class="passenger-info"><span class="name">Passenger 1</span><span class="passenger-info__seat_number"></span></div><div class="passenger-info__col--price_info"></div>';
 const m=await run('list_seat_map',html,{},'/seats/');assert.equal(m.out.seat_count,1);assert.equal(m.out.seats[0].seat_type,'standard');
 const input=seat=>({seat,confirm:true,expected_seat_fees:0});
 assert.equal((await run('select_seat',html,input('22A'),'/seats/')).out.status,'not_available');
 assert.equal((await run('select_seat',html,input('99A'),'/seats/')).out.status,'not_found');
 assert.equal((await run('select_seat',html,input('22B'),'/seats/',(el,doc)=>{doc.querySelector('.passenger-info__seat_number').textContent='22B'})).out.status,'selected');
 assert.equal((await run('select_seat',html,{...input('22B'),expected_seat_fees:10},'/seats/')).out.status,'stale_state');
});
test('seat save guards fees and skip schedules only CANCEL',async()=>{
 const html='<div class="passenger-info__col--price_info">+ $14.99</div><button>SAVE &amp; EXIT</button><button>CANCEL</button>';
 assert.equal((await run('continue_checkout',html,{confirm:true,from_step:'seat_map',expected_seat_fees:0},'/seats/')).out.status,'stale_state');
 const unreadable=await run('continue_checkout',html.replace('+ $14.99','Fee TBD'),{confirm:true,from_step:'seat_map',expected_seat_fees:0},'/seats/');assert.equal(unreadable.out.status,'error');assert.equal(unreadable.scheduled.length,0);
 assert.equal((await run('continue_checkout',html,{confirm:true,from_step:'seat_map',expected_seat_fees:14.99},'/seats/')).out.status,'navigation_scheduled');
 const r=await run('skip_seat_selection',html,{},'/seats/');assert.equal(r.out.status,'navigation_scheduled');assert.equal(r.scheduled.length,1);
});
test('QA regressions: insurance wording cannot reverse a choice',async()=>{
 const html=total+'<idp-display-trip-protection><label for="yes">Yes, protect my trip with no deductible</label><input type="radio" id="yes"><label for="no">I will take the risk</label><input type="radio" id="no"></idp-display-trip-protection>';
 const clicked=[];
 const r=await run('set_trip_protection',html,{choice:'decline',confirm:true,expected_total_due:123.41},undefined,(el,doc)=>{clicked.push(el.id);doc.getElementById(el.id).checked=true});
 assert.equal(r.out.status,'set');assert.deepEqual(clicked,['no']);assert.equal(r.out.amount_due,null);
});
test('QA regressions: identify masked card digits, not expiry years, before mutation',async()=>{
 const html=total+'<header><button>Log out</button></header><input id="saved" type="radio" data-cy="payment-method-radio"><label for="saved">Saved card</label><div data-cy="wallet-saved-card-dropdown"><div role="option">Visa ending in 1234 Exp 12/2028</div></div>';
 assert.equal((await run('list_payment_methods',html)).out.saved_cards[0].last4,'1234');
 let clicks=0;
 assert.equal((await run('select_saved_payment_method',html,{last4:'2028',confirm:true,expected_total_due:123.41},undefined,()=>clicks++)).out.status,'not_found');assert.equal(clicks,0);
 const selected=await run('select_saved_payment_method',html,{last4:'1234',confirm:true,expected_total_due:123.41},undefined,(el)=>{el.setAttribute('aria-selected','true');el.checked=true});assert.equal(selected.out.status,'selected');assert.equal(selected.out.last4,'1234');
});
test('QA regressions: unexpected direct seat fee must not be called free',async()=>{
 const html='<button class="seat-element" id="seat-10C" aria-label="Seat 10C available"></button><span class="passenger-info__seat_number"></span><div class="passenger-info__col--price_info"></div>';
 const r=await run('select_seat',html,{seat:'10C',confirm:true,expected_seat_fees:0},'/seats/',(el,doc)=>{doc.querySelector('.passenger-info__seat_number').textContent='10C';doc.querySelector('.passenger-info__col--price_info').textContent='$45.00'});assert.equal(r.out.status,'error');assert.match(r.out.error_message,/unapproved/);
 assert.equal((await run('select_seat','',{seat:'10C',confirm:true,expected_seat_fees:0},'/seats/')).out.status,'not_ready');
 assert.equal((await run('get_checkout_step','')).out.status,'not_ready');
});
test('express checkout recognizes observed signed-in control and section route',async()=>{
 const html=total+'<button id="mach-core-login-flyout-details"></button>'+passenger;
 const r=await run('get_checkout_step',html,{},'/purchase/flights/express-checkout');assert.equal(r.out.step,'review_and_pay');assert.equal(r.out.signed_in,true);assert.equal(r.out.active_section,'passenger_details');
 const c=await run('get_page_context',html,{},'/purchase/flights/express-checkout');assert.equal(c.out.page_type,'review_and_pay');assert.equal(c.out.signed_in,true);
 const p=await run('list_payment_methods',total+'<button id="mach-core-login-flyout-details"></button><div data-cy="wallet-saved-card-dropdown"><div role="option">VISA *1234 12/28</div></div>',{},'/purchase/flights/express-checkout');assert.equal(p.out.status,'ok');assert.equal(p.out.saved_cards[0].last4,'1234');
 const blocked=await run('list_payment_methods',total+'<button id="login-trigger">Log in</button><button id="mach-core-login-flyout-details"></button>',{},'/purchase/flights/express-checkout');assert.equal(blocked.out.status,'login_required');
});
test('express checkout skips optional seats and recognizes prefixed insurance labels',async()=>{
 const html=total+'<button data-cy="save-and-continue-seats-button">Save &amp; Continue</button>';
 let clicks=0;
 const stale=await run('continue_checkout',html,{confirm:true,from_step:'seats_and_upgrades',expected_total_due:10},'/purchase/flights/express-checkout',()=>clicks++);assert.equal(stale.out.status,'stale_state');assert.equal(clicks,0);
 const skipped=await run('continue_checkout',html,{confirm:true,from_step:'seats_and_upgrades',expected_total_due:123.41},'/purchase/flights/express-checkout',(el)=>{clicks++;el.setAttribute('hidden','')});assert.equal(skipped.out.status,'continued');assert.equal(clicks,1);
 const tp=total+'<idp-display-trip-protection><label for="yes">Trip Protection Yes, protect my trip with no deductible</label><input type="radio" id="yes"><label for="no">Trip Protection No, do not protect my trip</label><input type="radio" id="no"></idp-display-trip-protection>';
 const r=await run('set_trip_protection',tp,{choice:'decline',confirm:true,expected_total_due:123.41},'/purchase/flights/express-checkout',(el,doc)=>{assert.equal(el.id,'no');doc.getElementById('no').checked=true});assert.equal(r.out.status,'set');assert.equal(r.out.choice,'decline');
});
test('live insurance variant uses selectTripInsurance values and ignores incidental negatives',async()=>{
 const html=total+'<idp-display-trip-protection><input type="radio" name="selectTripInsurance" id="protectTrip" value="Yes"><label for="protectTrip">Protect my trip for $23.63 total.</label><input type="radio" name="selectTripInsurance" id="noProtectTrip" value="No"><label for="noProtectTrip">Do not protect my $123.41 trip.</label></idp-display-trip-protection>';
 let clicked;
 const r=await run('set_trip_protection',html,{choice:'decline',confirm:true,expected_total_due:123.41},'/purchase/flights/express-checkout',(el,doc)=>{clicked=el.id;doc.getElementById(clicked).checked=true});assert.equal(r.out.status,'set');assert.equal(clicked,'noProtectTrip');
 const state=await run('get_checkout_step',html,{},'/purchase/flights/express-checkout');assert.deepEqual(state.out.trip_protection.options.map(o=>o.choice),['accept','decline']);
 const wait=await run('set_trip_protection',total+'<idp-display-trip-protection></idp-display-trip-protection>',{choice:'decline',confirm:true,expected_total_due:123.41},'/purchase/flights/express-checkout');assert.equal(wait.out.status,'not_ready');
});
test('empty visible wallet CVV is required even without aria-required and prevents payment save',async()=>{
 const html=total+'<div><idp-section-container><idp-section><div class="font-primary">Payment</div></idp-section></idp-section-container><div data-cy="wallet-cvv-section"><input></div><button data-cy="save-and-continue-payment-button">Save &amp; Continue</button></div>';
 const step=await run('get_checkout_step',html,{},'/purchase/flights/express-checkout');assert.ok(step.out.missing_required_fields.includes('Card security code (CVV)'));
 let clicks=0;const c=await run('continue_checkout',html,{confirm:true,from_step:'payment',expected_total_due:123.41},'/purchase/flights/express-checkout',()=>clicks++);assert.equal(c.out.status,'missing_required_fields');assert.equal(clicks,0);
});
test('checked insurer radio with visible selection-required rejection is not success',async()=>{
 const html=total+'<div id="trip-protection-save-banner">Trip Protection Selection Required - Please make a selection</div><idp-display-trip-protection><input type="radio" name="selectTripInsurance" id="protectTrip" value="Yes"><label for="protectTrip">Protect my trip for $23.63</label><input type="radio" name="selectTripInsurance" id="noProtectTrip" value="No" checked><label for="noProtectTrip">Are you sure? It is not too late</label></idp-display-trip-protection>';
 let clicks=0;const r=await run('set_trip_protection',html,{choice:'decline',confirm:true,expected_total_due:123.41},'/purchase/flights/express-checkout',()=>clicks++);assert.equal(r.out.status,'error');assert.equal(clicks,0);
 const c=await run('get_checkout_step',html,{},'/purchase/flights/express-checkout');assert.equal(c.out.trip_protection.options[1].label,'Decline trip protection');
});
test('open seat map schedules navigation and reports missing affordance',async()=>{
 const r=await run('open_seat_map','<button data-cy="seat-selection-button">Select Seats</button>',{},'/purchase/flights/trip-summary');assert.equal(r.out.status,'navigation_scheduled');assert.equal(r.scheduled.length,1);
 assert.equal((await run('open_seat_map','',{},'/purchase/flights/trip-summary')).out.status,'not_offered');
});
