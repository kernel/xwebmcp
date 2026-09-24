import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../domains/jetblue.com/search_flights.js', import.meta.url), 'utf8');
const script = new vm.Script(`(${source}\n)`);
const input = { origin: 'JFK', destination: 'LAX', departDate: '2099-10-15', tripType: 'one_way', passengers: 2 };
const endpoint = 'https://www.jetblue.com/api/ecom/cb-flight-search/v1/search/NGB';

function harness(startUrl, { entryReady = true, responseStatus = 201, responseMissing = false } = {}) {
  const visits = [];
  const waits = [];
  const calls = [];
  const output = { status: 'no_results', resultCount: 0, flights: [] };
  const definitions = script.runInNewContext({
    URL, URLSearchParams,
    pageInfo: async () => ({ url: startUrl }),
    gotoUrl: async url => { visits.push(url); calls.push('navigate'); },
    waitForElement: async (selector, options) => {
      waits.push({ selector, ...options });
      return selector === 'input[name="from"]' ? entryReady : true;
    },
    waitForEvent: async (method, options) => {
      calls.push('observe');
      assert.equal(method, 'Network.responseReceived');
      assert.equal(options.predicate({ params: { response: { url: endpoint } } }), true);
      assert.equal(options.predicate({ params: { response: { url: 'https://example.com/' } } }), false);
      return responseMissing ? null : { params: { requestId: 'inventory', response: { status: responseStatus } } };
    },
    cdp: async (method, params) => {
      if (method === 'Network.enable') return {};
      assert.equal(method, 'Network.getResponseBody');
      assert.equal(params.requestId, 'inventory');
      return { base64Encoded: false, body: JSON.stringify({
        status: { transactionStatus: 'success' },
        data: { searchResults: [{ searchComponent: { from: input.origin, to: input.destination, date: input.departDate }, productOffers: [] }] }
      }) };
    },
    js: async () => output
  });
  return { definitions, visits, waits, calls, output, execute: definitions[0].execute };
}

test('source is a self-contained expression with domain-wide matching and typed schemas', () => {
  const { definitions } = harness('about:blank');
  assert.equal(definitions.length, 1);
  const definition = definitions[0];
  assert.equal(definition.kind, 'cdp');
  assert.deepEqual(Array.from(definition.match.url_patterns), ['https://jetblue.com/*', 'https://*.jetblue.com/*']);
  assert.equal(definition.tool.name, 'search_flights');
  assert.equal(definition.tool.inputSchema.properties.passengers.maximum, 7);
  assert.equal(definition.tool.outputSchema.properties.flights.items.properties.price.properties.amount.type, 'number');
  assert.equal(definition.tool.annotations.readOnlyHint, true);
});

for (const startUrl of ['https://www.jetblue.com/travel-agents', 'https://booking.jetblue.com/', 'https://jetblue.com/', 'https://example.com/', 'about:blank']) {
  test(`bootstraps the search entry point from ${startUrl}`, async () => {
    const h = harness(startUrl);
    assert.equal(await h.execute(input), h.output);
    assert.equal(h.visits[0], 'https://www.jetblue.com/');
    const destination = new URL(h.visits[1]);
    assert.equal(destination.pathname, '/booking/flights');
    assert.equal(destination.searchParams.get('adults'), '2');
    assert.equal(destination.searchParams.get('from'), 'JFK');
    assert.equal(destination.searchParams.get('to'), 'LAX');
    assert.equal(h.waits[0].state, 'attached');
    assert.equal(h.waits[0].timeoutSec, 30);
    assert.deepEqual(h.calls, ['navigate', 'observe', 'navigate']);
  });
}

for (const startUrl of ['https://www.jetblue.com/', 'https://www.jetblue.com/booking/flights?from=BOS']) {
  test(`starts a fresh inventory search from a suitable page: ${startUrl}`, async () => {
    const h = harness(startUrl);
    await h.execute(input);
    assert.equal(h.visits.length, 1);
    assert.equal(new URL(h.visits[0]).searchParams.get('from'), 'JFK');
    assert.deepEqual(h.calls, ['observe', 'navigate']);
  });
}

test('entry-point failure is explicit and does not submit a search', async () => {
  const h = harness('https://www.jetblue.com/travel-agents', { entryReady: false });
  await assert.rejects(h.execute(input), /entry point did not load/);
  assert.equal(h.visits.length, 1);
  assert.deepEqual(h.calls, ['navigate']);
});

test('HTTP failure cannot become an empty success', async () => {
  const h = harness('https://www.jetblue.com/', { responseStatus: 500 });
  await assert.rejects(h.execute(input), /Inventory HTTP failure/);
});

test('missing inventory response cannot become an empty success', async () => {
  const h = harness('https://www.jetblue.com/', { responseMissing: true });
  await assert.rejects(h.execute(input), /Inventory request failed or timed out/);
});

test('invalid passengers are rejected before any navigation', async () => {
  const h = harness('about:blank');
  await assert.rejects(h.execute({ ...input, passengers: 8 }), /1–7 adults/);
  assert.equal(h.visits.length, 0);
});
