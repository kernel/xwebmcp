import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./popup.js', import.meta.url), 'utf8');
function harness({granted = false, result = false, error = false} = {}) {
  const nodes = Object.fromEntries(['all-sites-status', 'grant-all-sites'].map(id => [id, {}]));
  const requests = [];
  const context = vm.createContext({
    document: {getElementById: id => nodes[id]},
    globalThis: {xw: {client: {}, urlPattern: {}}},
    chrome: {permissions: {
      contains: async () => granted,
      request: async input => {
        requests.push(JSON.parse(JSON.stringify(input)));
        if (error) throw new Error('denied');
        granted = result;
        return result;
      },
    }},
  });
  vm.runInContext(source.split("$('grant-all-sites').onclick = grantAllSites;")[0], context);
  vm.runInContext('render = async () => renderSiteAccess()', context);
  return {nodes, requests, run: expression => vm.runInContext(expression, context)};
}

test('all-sites access remains opt-in until clicked', async () => {
  const h = harness();
  await h.run('renderSiteAccess()');
  assert.equal(h.nodes['grant-all-sites'].hidden, false);
  assert.equal(h.requests.length, 0);
});

test('all-sites request grants HTTP and HTTPS including future sites', async () => {
  const h = harness({result: true});
  await h.run('grantAllSites()');
  assert.deepEqual(h.requests, [{origins: ['http://*/*', 'https://*/*']}]);
  assert.equal(h.nodes['grant-all-sites'].hidden, true);
  assert.equal(h.nodes['grant-all-sites'].disabled, false);
});

test('declining all-sites access leaves retry available', async () => {
  const h = harness();
  await h.run('grantAllSites()');
  assert.equal(h.nodes['grant-all-sites'].hidden, false);
  assert.equal(h.nodes['grant-all-sites'].disabled, false);
});

test('permission errors are reported and reset the button', async () => {
  const h = harness({error: true});
  await h.run('grantAllSites()');
  assert.match(h.nodes['all-sites-status'].textContent, /could not be granted/);
  assert.equal(h.nodes['grant-all-sites'].disabled, false);
});
