import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const tools = ['search', 'get_store', 'get_item', 'add_to_cart', 'get_cart', 'update_cart_item'];
const sources = Object.fromEntries(tools.map(name => [name, readFileSync(new URL(`../domains/ubereats.com/${name}.js`, import.meta.url), 'utf8')]));
const registry = JSON.parse(readFileSync(new URL('../registry.json', import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

// Validate the JSON Schema keywords used by these tools without adding a dependency.
function conforms(schema, value) {
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === 'null') return value === null;
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'array') return Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some(s => conforms(s, value))) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === 'object') {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (Array.isArray(value)) {
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
  }
  if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) return false;
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// Fixture ids. Store ids appear in both the UUID form and the base64url form used in store URLs.
const STORE = '347b31fd-a829-4672-b57f-9d074f5cb5ee';
const STORE_SHORT = 'NHsx_agpRnK1f50HT1y17g';
const RESTAURANT = '1e9211ee-e68f-54a1-8234-0befcf77f9e2';
const SECTION = '02872267-1108-5d69-815f-be61559db646';
const SUBSECTION = 'd0c62230-1e04-5fee-9112-745a8a244bc1';
const BANANAS = 'f07855dc-33cb-546a-8593-dfa3bec69553';
const DIP = 'edbd03f4-2713-5d83-b4c2-5baa7b7f79d1';
const GROUP = '004408a1-2b20-5bf2-8d28-c486810c5e35';
const OPTION = 'ad156b90-2736-55fa-a75d-c59881d2c014';
const OPTION2 = 'f6a9481f-4b2c-5d1e-8f3a-2b1c4d5e6f70';
const CHILD_GROUP = '5c8bcfed-004e-5544-9e42-00df06a9fc72';
const CHILD_OPTION = '5bdf9aa7-e26c-5df3-a7e4-464a66d18b96';
const CART = 'a665fa44-7e56-47c6-98e6-1c8d8e3f17f9';
const CART_UUID = '551c9c1d-3aac-455b-bbb5-61373b363728';
const LINE = '8ee3d642-c510-4921-a6c0-c528c8b354ae';
const NEW_LINE = '11111111-2222-4333-8444-555555555555';
const ZERO = '00000000-0000-0000-0000-000000000000';
const feedUrl = 'https://www.ubereats.com/feed?diningMode=DELIVERY';
const storeUrl = `https://www.ubereats.com/store/sainsburys-local/${STORE_SHORT}`;

const success = data => ({ status: 'success', data });
const failure = (message, code = '404') => ({ status: 'failure', data: { message, code } });

const bananasItem = (extra = {}) => ({ uuid: BANANAS, title: "Sainsbury's Fairtrade Bananas (5 pack)", itemDescription: 'Fruit', price: 135, isSoldOut: false, suspendReason: 'Item not available right now', hasCustomizations: false, customizationsList: [], sectionUuid: SECTION, subsectionUuid: SUBSECTION, productDetailsItems: [{ type: 'PRICING', payload: { pricingPayload: { pricingRichText: { richTextElements: [{ text: { text: { text: '£1.35' } } }] } } } }], ...extra });
const dipGroup = (extra = {}) => ({ uuid: GROUP, groupId: 0, title: 'Pick your dip', minPermitted: 1, maxPermitted: 1, options: [
  { uuid: OPTION, title: 'Garlic Dip', price: 0, defaultQuantity: 0, maxPermitted: 1, isSoldOut: false, childCustomizationList: [{ uuid: CHILD_GROUP, groupId: 0, title: 'Extras', minPermitted: 0, maxPermitted: 2, options: [{ uuid: CHILD_OPTION, title: 'Chilli', price: 50, defaultQuantity: 0, maxPermitted: 2, isSoldOut: false, childCustomizationList: [] }] }] },
  { uuid: OPTION2, title: 'Sold Out Dip', price: 25, defaultQuantity: 0, maxPermitted: 1, isSoldOut: true, childCustomizationList: [] }
], ...extra });
const dipItem = (extra = {}) => ({ uuid: DIP, title: 'Choose your dip', itemDescription: '', price: 100, isSoldOut: false, hasCustomizations: true, customizationsList: [dipGroup()], sectionUuid: SECTION, subsectionUuid: SUBSECTION, productDetailsItems: [], ...extra });

const cartLine = (extra = {}) => ({ shoppingCartItemUuid: LINE, uuid: BANANAS, storeUuid: STORE, sectionUuid: SECTION, subsectionUuid: SUBSECTION, quantity: 2, specialInstructions: '', title: "Sainsbury's Fairtrade Bananas (5 pack)", price: 0, customizations: {}, ...extra });
const draftOrder = (lines = [cartLine()], extra = {}) => ({ uuid: CART, storeUuid: STORE, shoppingCart: { cartUuid: CART_UUID, storeUuid: STORE, items: lines, currencyCode: '' }, ...extra });
const cartsView = (orders = [draftOrder()]) => ({ carts: orders.map(o => ({ draftOrderUUID: o.uuid, title: o.storeUuid === STORE ? "Sainsbury's Local" : 'PizzaExpress', itemCount: o.shoppingCart.items.reduce((n, l) => n + l.quantity, 0) })) });
const pricedOrder = (lines = [cartLine({ price: 135 })]) => ({ uuid: CART, storeUuid: STORE, state: 'UNORDERED', shoppingCart: { cartUuid: CART_UUID, storeUuid: STORE, items: lines, currencyCode: 'GBP' } });
const presentation = (subtotal, total) => ({ checkoutPayloads: { subtotal: { subtotal: { value: { amountE5: subtotal * 1000, currencyCode: 'GBP' }, formattedValue: `£${(subtotal / 100).toFixed(2)}` } }, total: { total: { value: { amountE5: total * 1000, currencyCode: 'GBP' }, formattedValue: `£${(total / 100).toFixed(2)}` } }, basketSize: { size: 2 } } });

const searchFeed = () => ({
  currencyCode: 'GBP', meta: { offset: 20, hasMore: true },
  feedItems: [
    { uuid: STORE, type: 'MINI_STORE_WITH_ITEMS', miniStoreWithItems: { store: { storeUuid: STORE, title: { text: "Sainsbury's Local - London" }, meta: [{ badgeType: 'FARE', text: '£0.29 Delivery Fee' }, { badgeType: 'ETD', text: '7:25PM' }], isStoreOpeningSoon: false }, items: [
      { uuid: BANANAS, title: { text: 'Bananas (5 pack)' }, subtitles: [{ text: '£1.35' }], sectionUuid: SECTION, subsectionUuid: SUBSECTION },
      { uuid: '762e60a3-b83b-558d-b831-5a7d93a6d694', title: { text: 'Organic Bananas' }, subtitles: [{ text: '£2.40' }], sectionUuid: SECTION, subsectionUuid: SUBSECTION },
      { uuid: 'no-section', title: { text: 'Broken entry' }, subtitles: [{ text: '£9.99' }] }
    ] } },
    { uuid: RESTAURANT, type: 'REGULAR_STORE', store: { storeUuid: RESTAURANT, title: { text: 'PizzaExpress' }, actionUrl: '/store/pizzaexpress/HpIR7uaPVKGCNAvvz3f54g', meta: [{ badgeType: 'FARE', text: '£0 Delivery Fee' }, { badgeType: 'ETD', text: '14 min' }], rating: { text: '4.3', badgeType: 'RATINGS' }, isStoreOpeningSoon: false } },
    { uuid: 'x', type: 'SORT_AND_FILTERS', payload: {} }
  ]
});

const storeData = (extra = {}) => ({
  uuid: STORE, title: "Sainsbury's Local", slug: 'sainsburys-local-london-queensways', location: { address: '75 Queensway, London, W2 4', locationType: 'GROCERY_STORE' },
  isOpen: true, isOrderable: true, closedMessage: '', currencyCode: 'GBP', etaRange: { text: '10–26 Min' }, fareBadge: { text: '£0.29 Delivery Fee' },
  storeInfoMetadata: { rawRatingStats: { storeRatingScore: 4.5109, ratingCount: '7,000+' } },
  storeMerchantTypeInfo: { uberMerchantType: { type: 'MERCHANT_TYPE_GROCERY' } },
  sections: [{ uuid: SECTION, title: 'Produce' }],
  aisles: { [STORE]: [{ type: 'CATEGORY_LIST_ITEM', payload: { categoryItemPayload: { title: 'Deals', sectionUUID: '7831870f-bd8a-4a2d-8db9-d1c7942d26c0' } } }, { type: 'CATEGORY_LIST_ITEM', payload: { categoryItemPayload: { title: 'Produce', sectionUUID: SECTION } } }] },
  catalogSectionsMap: { [SECTION]: [
    { type: 'EATER_MESSAGE', payload: { eaterMessagingPayload: {} } },
    { type: 'HORIZONTAL_GRID', catalogSectionUUID: SUBSECTION, payload: { standardItemsPayload: { title: { text: 'Featured' }, catalogItems: [
      { uuid: BANANAS, title: 'Bananas', itemDescription: 'Fruit', price: 135, priceTagline: { text: '£1.35' }, isSoldOut: false, isAvailable: true, hasCustomizations: false, sectionUuid: SECTION, subsectionUuid: SUBSECTION },
      { uuid: DIP, title: 'Loose Apples', price: 232.5, priceTagline: { text: '£2.33/kg' }, isSoldOut: true, isAvailable: false, hasCustomizations: false },
      { uuid: BANANAS, title: 'Duplicate', price: 1 }
    ] } } }
  ] },
  ...extra
});

const restaurantData = () => storeData({ uuid: RESTAURANT, title: 'PizzaExpress', slug: 'pizzaexpress', location: { address: 'Notting Hill Gate', locationType: 'RESTAURANT' }, storeMerchantTypeInfo: { uberMerchantType: { type: 'MERCHANT_TYPE_RESTAURANT' } }, aisles: {}, sections: [{ uuid: SECTION, title: 'Menu' }] });

function harness(name, options = {}) {
  const calls = [];
  let url = options.url ?? feedUrl;
  const responses = { ...options.responses };
  const context = {
    URL, JSON, TextEncoder, atob, btoa,
    document: { get readyState() { return 'complete'; } },
    crypto: { randomUUID: () => NEW_LINE },
    fetch: async (path, init) => {
      const api = path.replace(/^\/_p\/api\//, '').replace(/\?.*$/, '');
      const body = JSON.parse(init.body);
      calls.push({ api, body });
      const handler = responses[api];
      if (!handler) throw new Error(`unexpected api ${api}`);
      const raw = typeof handler === 'function' ? handler(body, calls) : handler;
      const reply = raw && typeof raw === 'object' && 'status' in raw ? raw : success(raw);
      return { status: 200, text: async () => JSON.stringify(reply), json: async () => reply };
    },
    js: async (fn, opts) => { calls.push({ js: true }); return fn(opts?.arg); },
    cdp: async method => { calls.push({ cdp: method }); return { cookies: options.noAddress ? [] : [{ name: 'uev2.loc', value: 'x'.repeat(40) }] }; },
    pageInfo: async () => { calls.push({ pageInfo: true }); return { url }; },
    gotoUrl: async next => { calls.push({ gotoUrl: next }); url = options.navigationFails ? url : next; },
    waitMs: async () => {},
  };
  const definitions = runInNewContext(`(${sources[name]})`, context);
  return {
    definitions, calls,
    apiCalls: () => calls.filter(c => c.api).map(c => c.api),
    run: async input => {
      const result = plain(await definitions[0].execute(input));
      assert.ok(conforms(definitions[0].tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    },
  };
}

const loggedIn = { getUserV1: success({ isLoggedIn: true, hashedEmail: 'x'.repeat(64) }) };
const loggedOut = { getUserV1: success({ isLoggedIn: false }) };

for (const name of tools) {
  test(`${name}: single-expression CDP tool matching the registry and declaring typed schemas`, () => {
    const [definition] = harness(name).definitions;
    assert.equal(definition.kind, 'cdp');
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ['https://ubereats.com/*', 'https://*.ubereats.com/*']);
    assert.equal(definition.tool.inputSchema.type, 'object');
    assert.equal(definition.tool.outputSchema.type, 'object');
    assert.ok(!sources[name].trimEnd().endsWith(';'));
    assert.ok(!/\b(Buffer|require|process)\b/.test(sources[name]), 'must not use Node-only globals');
    const entry = registry.tools.find(t => t.domain === 'ubereats.com' && t.tool === name);
    assert.equal(entry.file, `domains/ubereats.com/${name}.js`);
    assert.equal(entry.kind, 'cdp');
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

const invalidInputs = {
  search: [{}, { query: '' }, { query: 'x'.repeat(201) }, { query: 'a', offset: -1 }, { query: 'a', offset: 1.5 }, { query: 'a', max_items_per_store: 21 }, { query: 'a', extra: 1 }, null, ['a']],
  get_store: [{}, { store_id: 'not-an-id' }, { store_id: STORE, query: '' }, { store_id: STORE, max_items: 0 }, { store_id: STORE, extra: 1 }, null],
  get_item: [{}, { store_id: STORE, item_id: BANANAS, section_id: SECTION }, { store_id: STORE, item_id: 'x', section_id: SECTION, subsection_id: SUBSECTION }, { store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION, extra: 1 }, null],
  add_to_cart: [{}, { store_id: STORE, item_id: BANANAS, section_id: SECTION }, { store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION, quantity: 0 }, { store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION, quantity: 51 }, { store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION, options: [{ group_id: GROUP }] }, { store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION, options: [{ group_id: GROUP, option_id: OPTION, quantity: 0 }] }, { store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION, special_instructions: 'x'.repeat(501) }, { store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION, extra: 1 }, null],
  get_cart: [{ extra: 1 }, [1], 'x'],
  update_cart_item: [{}, { cart_id: CART, line_id: LINE }, { cart_id: 'x', line_id: LINE, quantity: 1 }, { cart_id: CART, line_id: LINE, quantity: -1 }, { cart_id: CART, line_id: LINE, quantity: 51 }, { cart_id: CART, line_id: LINE, quantity: 1, extra: 1 }, null],
};

for (const [name, inputs] of Object.entries(invalidInputs)) {
  for (const input of inputs) {
    test(`${name}: invalid input is rejected before any page action: ${JSON.stringify(input)}`, async () => {
      const h = harness(name);
      if (input && typeof input === 'object' && !Array.isArray(input)) assert.equal(conforms(h.definitions[0].tool.inputSchema, input), false);
      const result = await h.run(input);
      assert.equal(result.ok, false);
      assert.equal(result.error_kind, 'invalid_input');
      assert.deepEqual(h.calls, []);
    });
  }
}

test('search: parses stores and matched items from both feed entry types', async () => {
  const h = harness('search', { responses: { getSearchFeedV1: searchFeed() } });
  const result = await h.run({ query: ' banana ', max_items_per_store: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.currency, 'GBP');
  assert.equal(result.stores.length, 2);
  const [grocery, restaurant] = result.stores;
  assert.equal(grocery.kind, 'store_with_items');
  assert.equal(grocery.url, `https://www.ubereats.com/store/-/${STORE_SHORT}`);
  assert.deepEqual(grocery.items.map(i => [i.name, i.price_minor]), [['Bananas (5 pack)', 135], ['Organic Bananas', 240]]);
  assert.deepEqual([grocery.delivery_fee_text, grocery.eta_text], ['£0.29 Delivery Fee', '7:25PM']);
  assert.equal(restaurant.kind, 'store');
  assert.equal(restaurant.rating, 4.3);
  assert.equal(restaurant.url, 'https://www.ubereats.com/store/pizzaexpress/HpIR7uaPVKGCNAvvz3f54g');
  assert.deepEqual([result.has_more, result.next_offset], [true, 20]);
  assert.equal(h.calls.find(c => c.api).body.query, 'banana');
  assert.deepEqual(h.calls.filter(c => c.gotoUrl), []);
});

test('search: pages with the offset and reports the end of results', async () => {
  const h = harness('search', { responses: { getSearchFeedV1: body => ({ ...searchFeed(), meta: { offset: body.pageInfo.offset + 20, hasMore: false } }) } });
  const result = await h.run({ query: 'pizza', offset: 40 });
  assert.equal(h.calls.find(c => c.api).body.pageInfo.offset, 40);
  assert.deepEqual([result.has_more, result.next_offset], [false, null]);
});

test('search: a session without a delivery address is reported without a site call', async () => {
  const h = harness('search', { noAddress: true, responses: { getSearchFeedV1: searchFeed() } });
  const result = await h.run({ query: 'banana' });
  assert.equal(result.error_kind, 'no_delivery_address');
  assert.deepEqual(h.apiCalls(), []);
});

test('search: an unrelated page is left for the site first', async () => {
  const h = harness('search', { url: 'https://example.com/', responses: { getSearchFeedV1: searchFeed() } });
  const result = await h.run({ query: 'banana' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.filter(c => c.gotoUrl).map(c => c.gotoUrl), ['https://www.ubereats.com/']);
});

test('search: a navigation that never lands on the site fails closed', async () => {
  const h = harness('search', { url: 'https://example.com/', navigationFails: true, responses: { getSearchFeedV1: searchFeed() } });
  const result = await h.run({ query: 'banana' });
  assert.equal(result.error_kind, 'unknown');
  assert.deepEqual(h.apiCalls(), []);
});

test('search: a site failure is reported as site_error with the site message', async () => {
  const h = harness('search', { responses: { getSearchFeedV1: failure('Something went wrong', '500') } });
  const result = await h.run({ query: 'banana' });
  assert.equal(result.error_kind, 'site_error');
  assert.match(result.error_message, /Something went wrong/);
});

test('get_store: grocery store lists categories from sections and aisles, dedups items, rounds prices, and accepts the URL id', async () => {
  const h = harness('get_store', { url: storeUrl, responses: { getStoreV1: storeData() } });
  const result = await h.run({ store_id: STORE_SHORT });
  assert.equal(result.ok, true);
  assert.equal(h.calls.find(c => c.api).body.storeUuid, STORE);
  assert.deepEqual([result.kind, result.name, result.rating, result.rating_count, result.open, result.orderable], ['grocery', "Sainsbury's Local", 4.5, '7,000+', true, true]);
  assert.equal(result.url, `https://www.ubereats.com/store/sainsburys-local-london-queensways/${STORE_SHORT}`);
  assert.deepEqual(result.categories.map(c => c.title), ['Produce', 'Deals']);
  assert.deepEqual(result.items.map(i => [i.name, i.price_minor, i.sold_out, i.available, i.category]), [['Bananas', 135, false, true, 'Featured'], ['Loose Apples', 233, true, false, 'Featured']]);
  assert.equal(result.items_truncated, false);
});

test('get_store: max_items caps the list and reports truncation', async () => {
  const h = harness('get_store', { responses: { getStoreV1: storeData() } });
  const result = await h.run({ store_id: STORE, max_items: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items_truncated, true);
});

test('get_store: query searches inside the store instead of listing the menu', async () => {
  const h = harness('get_store', { responses: { getStoreV1: restaurantData(), getInStoreSearchV1: body => success({ catalogSectionsMap: { [SECTION]: [{ type: 'VERTICAL_GRID', catalogSectionUUID: SUBSECTION, payload: { standardItemsPayload: { catalogItems: [{ uuid: DIP, title: 'Garlic Bread', price: 795, isSoldOut: false, isAvailable: true, hasCustomizations: true, sectionUuid: SECTION, subsectionUuid: SUBSECTION }] } } }] } }) } });
  const result = await h.run({ store_id: RESTAURANT, query: 'garlic' });
  assert.equal(result.kind, 'restaurant');
  const search = h.calls.find(c => c.api === 'getInStoreSearchV1').body;
  assert.deepEqual([search.userQuery, search.isGrocery, search.storeUUIDs], ['garlic', false, [RESTAURANT]]);
  assert.deepEqual(result.items.map(i => [i.name, i.has_options, i.category]), [['Garlic Bread', true, 'Menu']]);
});

test('get_store: an unknown store is not_found', async () => {
  const h = harness('get_store', { responses: { getStoreV1: failure('We had an issue finding this store') } });
  const result = await h.run({ store_id: ZERO });
  assert.equal(result.error_kind, 'not_found');
});

test('get_item: returns price, availability, and nested option groups', async () => {
  const h = harness('get_item', { responses: { getMenuItemV1: dipItem() } });
  const result = await h.run({ store_id: RESTAURANT, item_id: DIP, section_id: SECTION, subsection_id: SUBSECTION });
  assert.equal(result.ok, true);
  assert.deepEqual([result.price_minor, result.sold_out, result.has_options], [100, false, true]);
  const [group] = result.option_groups;
  assert.deepEqual([group.group_id, group.min, group.max, group.options.length], [GROUP, 1, 1, 2]);
  assert.deepEqual(group.options[0].child_groups[0].options[0], { option_id: CHILD_OPTION, title: 'Chilli', price_minor: 50, sold_out: false, default_quantity: 0, max_quantity: 2, child_groups: [] });
  assert.equal(group.options[1].sold_out, true);
});

test('get_item: a sold-out item reports the site reason', async () => {
  const h = harness('get_item', { responses: { getMenuItemV1: bananasItem({ isSoldOut: true }) } });
  const result = await h.run({ store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION });
  assert.deepEqual([result.sold_out, result.unavailable_reason, result.price_text], [true, 'Item not available right now', '£1.35']);
});

test('get_item: an unknown item is not_found', async () => {
  const h = harness('get_item', { responses: { getMenuItemV1: failure('ITEM_NOT_FOUND') } });
  assert.equal((await h.run({ store_id: STORE, item_id: ZERO, section_id: SECTION, subsection_id: SUBSECTION })).error_kind, 'not_found');
});

const cartReads = (orders, priced = pricedOrder(), totals = presentation(270, 708)) => ({
  getDraftOrdersByEaterUuidV1: () => success({ draftOrders: orders(), cartsView: cartsView(orders()) }),
  getDraftOrderByUuidV1: priced ? success(priced) : failure('Found invalid item', '500'),
  getCheckoutPresentationV1: totals ? success(totals) : failure('unavailable', '500'),
});

const addInput = { store_id: STORE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION };

test('add_to_cart: a signed-out session adds nothing', async () => {
  const h = harness('add_to_cart', { responses: { ...loggedOut, getMenuItemV1: bananasItem() } });
  const result = await h.run(addInput);
  assert.equal(result.error_kind, 'not_logged_in');
  assert.deepEqual(h.apiCalls(), ['getUserV1']);
});

test('add_to_cart: a sold-out item adds nothing', async () => {
  const h = harness('add_to_cart', { responses: { ...loggedIn, getMenuItemV1: bananasItem({ isSoldOut: true }) } });
  const result = await h.run(addInput);
  assert.equal(result.error_kind, 'unavailable');
  assert.match(result.error_message, /not available right now/);
  assert.deepEqual(h.apiCalls(), ['getUserV1', 'getMenuItemV1']);
});

test('add_to_cart: an unknown item adds nothing', async () => {
  const h = harness('add_to_cart', { responses: { ...loggedIn, getMenuItemV1: failure('ITEM_NOT_FOUND') } });
  assert.equal((await h.run({ ...addInput, item_id: ZERO })).error_kind, 'not_found');
  assert.deepEqual(h.apiCalls(), ['getUserV1', 'getMenuItemV1']);
});

for (const [label, options, pattern] of [
  ['a missing required pick', [], /needs at least 1/],
  ['too many picks', [{ group_id: GROUP, option_id: OPTION }, { group_id: GROUP, option_id: OPTION2 }], /at most 1/],
  ['a sold-out option', [{ group_id: GROUP, option_id: OPTION2 }], /sold out/],
  ['an option from another item', [{ group_id: CHILD_GROUP, option_id: CHILD_OPTION }], /needs at least 1.*not offered/s],
  ['an option id outside its group', [{ group_id: GROUP, option_id: CHILD_OPTION }], /not in group/],
  ['a child pick above its limit', [{ group_id: GROUP, option_id: OPTION }, { group_id: CHILD_GROUP, option_id: CHILD_OPTION, quantity: 3 }], /at most 2/],
]) {
  test(`add_to_cart: ${label} is rejected before any cart call`, async () => {
    const h = harness('add_to_cart', { responses: { ...loggedIn, getMenuItemV1: dipItem() } });
    const result = await h.run({ ...addInput, store_id: RESTAURANT, item_id: DIP, options });
    assert.equal(result.error_kind, 'invalid_options');
    assert.match(result.error_message, pattern);
    assert.deepEqual(h.apiCalls(), ['getUserV1', 'getMenuItemV1']);
  });
}

test('add_to_cart: creates the store cart when none exists and reports the new line', async () => {
  let orders = [];
  const h = harness('add_to_cart', { responses: {
    ...loggedIn, getMenuItemV1: bananasItem(),
    ...cartReads(() => orders, pricedOrder([cartLine({ shoppingCartItemUuid: NEW_LINE, quantity: 1, price: 135 })]), presentation(135, 573)),
    createDraftOrderV2: body => { orders = [draftOrder([cartLine({ shoppingCartItemUuid: body.shoppingCartItems[0].shoppingCartItemUuid, quantity: 1 })])]; return success({ draftOrder: orders[0] }); },
  } });
  const result = await h.run({ ...addInput, special_instructions: 'ripe please' });
  assert.equal(result.ok, true);
  assert.deepEqual([result.cart_id, result.line_id, result.quantity, result.unit_price_minor, result.currency], [CART, NEW_LINE, 1, 135, 'GBP']);
  const create = h.calls.find(c => c.api === 'createDraftOrderV2').body;
  assert.deepEqual(create.shoppingCartItems[0], { uuid: BANANAS, shoppingCartItemUuid: NEW_LINE, storeUuid: STORE, sectionUuid: SECTION, subsectionUuid: SUBSECTION, price: 135, title: "Sainsbury's Fairtrade Bananas (5 pack)", quantity: 1, customizations: {}, specialInstructions: 'ripe please' });
  assert.ok(!('paymentProfileUUID' in create) && !('promotionOptions' in create));
  assert.deepEqual([result.cart.subtotal_minor, result.cart.total_text, result.cart.items[0].line_total_minor], [135, '£5.73', 135]);
});

test('add_to_cart: adds to the existing store cart and reports the merged line quantity', async () => {
  let orders = [draftOrder()];
  const h = harness('add_to_cart', { responses: {
    ...loggedIn, getMenuItemV1: bananasItem(),
    ...cartReads(() => orders, pricedOrder([cartLine({ quantity: 3, price: 135 })]), presentation(405, 843)),
    addItemsToDraftOrderV2: body => { orders = [draftOrder([cartLine({ quantity: 3 })])]; return success({ addedItems: body.items }); },
  } });
  const result = await h.run(addInput);
  assert.equal(result.ok, true);
  assert.deepEqual([result.line_id, result.quantity], [LINE, 3]);
  const add = h.calls.find(c => c.api === 'addItemsToDraftOrderV2').body;
  assert.deepEqual([add.draftOrderUUID, add.cartUUID, add.storeUUID, add.items[0].quantity], [CART, CART_UUID, STORE, 1]);
  assert.ok(!h.apiCalls().includes('createDraftOrderV2'));
});

test('add_to_cart: option picks are sent in the site\'s customization map and priced into the unit price', async () => {
  let orders = [];
  const h = harness('add_to_cart', { responses: {
    ...loggedIn, getMenuItemV1: dipItem(),
    ...cartReads(() => orders, pricedOrder([cartLine({ shoppingCartItemUuid: NEW_LINE, uuid: DIP, storeUuid: RESTAURANT, quantity: 2, price: 100, customizations: { [`${GROUP}+0`]: [{ uuid: OPTION, price: 0, quantity: 1, title: 'Garlic Dip', customizationMeta: { title: 'Pick your dip' } }], [`${CHILD_GROUP}+0`]: [{ uuid: CHILD_OPTION, price: 50, quantity: 2, title: 'Chilli', customizationMeta: { title: 'Extras' } }] } })]), presentation(400, 600)),
    createDraftOrderV2: body => { orders = [draftOrder([cartLine({ shoppingCartItemUuid: body.shoppingCartItems[0].shoppingCartItemUuid, uuid: DIP, storeUuid: RESTAURANT, quantity: 2, customizations: body.shoppingCartItems[0].customizations })], { storeUuid: RESTAURANT })]; return success({ draftOrder: orders[0] }); },
  } });
  const result = await h.run({ ...addInput, store_id: RESTAURANT, item_id: DIP, quantity: 2, options: [{ group_id: GROUP, option_id: OPTION }, { group_id: CHILD_GROUP, option_id: CHILD_OPTION, quantity: 2 }] });
  assert.equal(result.ok, true);
  assert.equal(result.unit_price_minor, 200);
  const sent = h.calls.find(c => c.api === 'createDraftOrderV2').body.shoppingCartItems[0].customizations;
  assert.deepEqual(Object.keys(sent), [`${GROUP}+0`, `${CHILD_GROUP}+0`]);
  assert.deepEqual(sent[`${GROUP}+0`], [{ uuid: OPTION, price: 0, quantity: 1, title: 'Garlic Dip', defaultQuantity: 0, customizationMeta: { title: 'Pick your dip', isPickOne: true } }]);
  assert.deepEqual(sent[`${CHILD_GROUP}+0`][0].quantity, 2);
  assert.deepEqual(result.cart.items[0].options.map(o => [o.group_title, o.title, o.quantity, o.price_minor]), [['Pick your dip', 'Garlic Dip', 1, 0], ['Extras', 'Chilli', 2, 50]]);
  assert.equal(result.cart.items[0].unit_price_minor, 200);
});

test('add_to_cart: a merged line is found by item and options when the site renames the line', async () => {
  let orders = [draftOrder([cartLine({ quantity: 1 })])];
  const h = harness('add_to_cart', { responses: {
    ...loggedIn, getMenuItemV1: bananasItem(),
    ...cartReads(() => orders, pricedOrder([cartLine({ quantity: 2, price: 135 })]), presentation(270, 708)),
    addItemsToDraftOrderV2: () => { orders = [draftOrder([cartLine({ quantity: 2 })])]; return success({ addedItems: [] }); },
  } });
  const result = await h.run(addInput);
  assert.deepEqual([result.line_id, result.quantity], [LINE, 2]);
});

test('add_to_cart: a create call that returns no cart is reported, not retried', async () => {
  const h = harness('add_to_cart', { responses: { ...loggedIn, getMenuItemV1: bananasItem(), ...cartReads(() => []), createDraftOrderV2: success({ draftOrder: null }) } });
  const result = await h.run(addInput);
  assert.equal(result.error_kind, 'site_error');
  assert.equal(h.apiCalls().filter(a => a === 'createDraftOrderV2').length, 1);
});

test('get_cart: a signed-out session is reported', async () => {
  const h = harness('get_cart', { responses: loggedOut });
  assert.equal((await h.run({})).error_kind, 'not_logged_in');
});

test('get_cart: an empty account returns no carts', async () => {
  const h = harness('get_cart', { responses: { ...loggedIn, getDraftOrdersByEaterUuidV1: success({ draftOrders: [], cartsView: { carts: [] } }) } });
  assert.deepEqual(await h.run({}), { ok: true, carts: [] });
});

test('get_cart: lines carry unit prices from the priced order and totals from the presentation', async () => {
  const h = harness('get_cart', { responses: { ...loggedIn, ...cartReads(() => [draftOrder()]) } });
  const result = await h.run(undefined);
  assert.equal(result.carts.length, 1);
  const [cart] = result.carts;
  assert.deepEqual([cart.cart_id, cart.store_id, cart.store_name, cart.currency, cart.item_count], [CART, STORE, "Sainsbury's Local", 'GBP', 2]);
  assert.deepEqual([cart.subtotal_minor, cart.subtotal_text, cart.total_minor, cart.total_text], [270, '£2.70', 708, '£7.08']);
  assert.deepEqual(cart.items[0], { line_id: LINE, item_id: BANANAS, section_id: SECTION, subsection_id: SUBSECTION, name: "Sainsbury's Fairtrade Bananas (5 pack)", quantity: 2, unit_price_minor: 135, line_total_minor: 270, options: [], special_instructions: '' });
});

test('get_cart: a cart the site cannot price still lists its lines with null prices', async () => {
  const h = harness('get_cart', { responses: { ...loggedIn, ...cartReads(() => [draftOrder()], null, null) } });
  const [cart] = (await h.run({})).carts;
  assert.deepEqual([cart.items[0].unit_price_minor, cart.items[0].line_total_minor, cart.subtotal_minor, cart.total_text], [null, null, null, null]);
});

test('update_cart_item: an unknown cart or line changes nothing', async () => {
  const h = harness('update_cart_item', { responses: { ...loggedIn, ...cartReads(() => [draftOrder()]) } });
  assert.equal((await h.run({ cart_id: ZERO, line_id: LINE, quantity: 1 })).error_kind, 'not_found');
  assert.equal((await h.run({ cart_id: CART, line_id: ZERO, quantity: 1 })).error_kind, 'not_found');
  assert.deepEqual(h.apiCalls().filter(a => /update|remove/i.test(a)), []);
});

test('update_cart_item: a signed-out session changes nothing', async () => {
  const h = harness('update_cart_item', { responses: loggedOut });
  assert.equal((await h.run({ cart_id: CART, line_id: LINE, quantity: 1 })).error_kind, 'not_logged_in');
});

test('update_cart_item: sets a new quantity with the line\'s own fields and the priced unit price', async () => {
  let orders = [draftOrder()];
  const h = harness('update_cart_item', { responses: {
    ...loggedIn, ...cartReads(() => orders, pricedOrder([cartLine({ quantity: 3, price: 135 })]), presentation(405, 843)),
    updateItemInDraftOrderV2: body => { orders = [draftOrder([cartLine({ quantity: body.item.quantity })])]; return success({ item: body.item }); },
  } });
  const result = await h.run({ cart_id: CART, line_id: LINE, quantity: 3 });
  assert.deepEqual([result.ok, result.quantity, result.removed, result.cart_deleted, result.cart.items[0].quantity], [true, 3, false, false, 3]);
  const update = h.calls.find(c => c.api === 'updateItemInDraftOrderV2').body;
  assert.deepEqual([update.draftOrderUUID, update.cartUUID, update.storeUUID, update.item.shoppingCartItemUuid, update.item.quantity, update.item.price, update.item.customizations], [CART, CART_UUID, STORE, LINE, 3, 135, {}]);
});

test('update_cart_item: the same quantity makes no site change', async () => {
  const h = harness('update_cart_item', { responses: { ...loggedIn, ...cartReads(() => [draftOrder()]) } });
  const result = await h.run({ cart_id: CART, line_id: LINE, quantity: 2 });
  assert.deepEqual([result.ok, result.quantity], [true, 2]);
  assert.deepEqual(h.apiCalls().filter(a => /update|remove/i.test(a)), []);
});

test('update_cart_item: quantity 0 removes the line, and the last line deletes the cart', async () => {
  let orders = [draftOrder([cartLine(), cartLine({ shoppingCartItemUuid: NEW_LINE, uuid: DIP })])];
  const h = harness('update_cart_item', { responses: {
    ...loggedIn, ...cartReads(() => orders, pricedOrder([cartLine({ shoppingCartItemUuid: NEW_LINE, uuid: DIP, price: 100 })]), presentation(200, 400)),
    removeItemsFromDraftOrderV2: body => { orders = orders.map(o => draftOrder(o.shoppingCart.items.filter(l => !body.shoppingCartItemUUIDs.includes(l.shoppingCartItemUuid)))).filter(o => o.shoppingCart.items.length); return success({ shoppingCartItemUUIDs: body.shoppingCartItemUUIDs }); },
  } });
  const first = await h.run({ cart_id: CART, line_id: LINE, quantity: 0 });
  assert.deepEqual([first.removed, first.cart_deleted, first.cart.items.length], [true, false, 1]);
  const last = await h.run({ cart_id: CART, line_id: NEW_LINE, quantity: 0 });
  assert.deepEqual([last.removed, last.cart_deleted, last.cart], [true, true, null]);
  assert.deepEqual(h.calls.filter(c => c.api === 'removeItemsFromDraftOrderV2').map(c => c.body.shoppingCartItemUUIDs), [[LINE], [NEW_LINE]]);
});

test('update_cart_item: a quantity the site does not apply is reported as site_error', async () => {
  const h = harness('update_cart_item', { responses: { ...loggedIn, ...cartReads(() => [draftOrder()]), updateItemInDraftOrderV2: success({}) } });
  assert.equal((await h.run({ cart_id: CART, line_id: LINE, quantity: 5 })).error_kind, 'site_error');
});
