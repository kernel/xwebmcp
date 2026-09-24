import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../domains/alaskaair.com/search_flights.js', import.meta.url), 'utf8');
const input = {
  origin: 'SEA', destination: 'SFO',
  depart_date: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
  trip_type: 'one_way', passengers: 1,
};
const target = `https://www.alaskaair.com/search/results?O=SEA&D=SFO&OD=${input.depart_date}&A=1&RT=false&locale=en-us`;

function harness(startUrl, { title = 'Select Flights', ready = true, navigationError } = {}) {
  let url = startUrl;
  const navigations = [];
  const events = [];
  const context = {
    URL, URLSearchParams,
    pageInfo: async () => { events.push('inspect'); return { url }; },
    gotoUrl: async next => {
      events.push('navigate');
      if (navigationError) throw new Error(navigationError);
      navigations.push(next);
      url = next;
    },
    waitForLoad: async () => true,
    waitForElement: async () => ready,
    js: async fn => vm.runInNewContext(`(${fn.toString()})()`, {
      location: { href: url },
      document: {
        title,
        querySelector: selector => selector === '.no-flights'
          ? { innerText: 'No results available. Try changing your search.' }
          : null,
        querySelectorAll: () => [],
      },
    }),
  };
  const definitions = vm.runInNewContext(`(${source})`, context);
  return { definitions, execute: definitions[0].execute, navigations, events };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('source is a self-contained nonempty tool-definition expression', () => {
  const { definitions } = harness('about:blank');
  assert.equal(definitions.length, 1);
  const definition = definitions[0];
  assert.equal(definition.kind, 'cdp');
  assert.equal(definition.tool.name, 'search_flights');
  assert.equal(definition.tool.inputSchema.type, 'object');
  assert.equal(definition.tool.outputSchema.type, 'object');
  assert.equal(definition.tool.annotations.readOnlyHint, true);
  assert.deepEqual(plain(definition.match.url_patterns), [
    'https://alaskaair.com/*', 'https://*.alaskaair.com/*',
  ]);
});

for (const start of [
  'https://www.alaskaair.com/content/travel-info',
  'https://alaskaair.com/',
  'https://booking.alaskaair.com/other-flow',
  'https://example.com/',
  'about:blank',
  'https://www.alaskaair.com/search/results?O=SEA&D=NRT',
  target,
]) {
  test(`inspect and navigate from ${start}`, async () => {
    const h = harness(start);
    const output = await h.execute(input);
    assert.deepEqual(h.events, ['inspect', 'navigate']);
    assert.deepEqual(h.navigations, [target]);
    assert.equal(output.status, 'no_results');
    assert.equal(output.results_url, target);
    assert.equal(output.result_count, 0);
    assert.equal(output.total_results, 0);
    assert.equal(output.has_more, false);
    assert.deepEqual(plain(output.flights), []);
  });
}

test('navigation failure remains an explicit error', async () => {
  const h = harness('about:blank', { navigationError: 'Navigation failed' });
  const output = await h.execute(input);
  assert.equal(output.status, 'error');
  assert.equal(output.message, 'Navigation failed');
  assert.equal(output.total_results, null);
});

test('missing result signals remain an error, not no_results', async () => {
  const output = await harness('about:blank', { ready: false }).execute(input);
  assert.equal(output.status, 'error');
  assert.match(output.message, /Timed out/);
  assert.equal(output.total_results, null);
});

test('proxy failures allow only one navigation retry', async () => {
  const h = harness('about:blank', { title: 'proxy error' });
  const output = await h.execute(input);
  assert.equal(output.status, 'error');
  assert.match(output.message, /Proxy error/);
  assert.deepEqual(h.navigations, [target, target]);
});

test('invalid inputs are rejected before page inspection or navigation', async () => {
  for (const invalid of [
    { ...input, origin: input.destination },
    { ...input, passengers: 0 },
    { ...input, trip_type: 'round_trip' },
    { ...input, depart_date: '2027-02-30' },
  ]) {
    const h = harness('about:blank');
    await assert.rejects(h.execute(invalid));
    assert.deepEqual(h.events, []);
  }
});
