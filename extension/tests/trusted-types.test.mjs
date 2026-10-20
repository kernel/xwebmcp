import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {chromium, waitFor} from './chromium.mjs';
import {channelId, videoId, playlistId, token, html, script, response} from './youtube-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = ['get_channel', 'get_playlist', 'get_transcript', 'get_video', 'list_channel_videos', 'search', 'set_subscription'];
const sources = await Promise.all(names.map(name => readFile(new URL(`../../domains/youtube.com/${name}.js`, import.meta.url), 'utf8')));
const batch = `[${sources.map(source => `...(${source})`).join(',')}]`;
const policies = {
  trusted_types: "script-src 'self' 'unsafe-eval'; require-trusted-types-for 'script'; trusted-types 'none'",
  csp: "script-src 'self'",
  both: "script-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'",
};

test('stored page tools register through CSP/Trusted Types without changing kind or document lifetime', {timeout: 120000}, async t => {
  const extension = await mkdtemp(join(tmpdir(), 'xwebmcp-test-extension-'));
  let browser;
  try {
    await cp(root, extension, {recursive: true, filter: path => !path.includes('/tests/')});
    const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
    // Only this throwaway fixture package has pre-granted access; production permissions are untouched.
    manifest.host_permissions.push('https://www.youtube.com/*');
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(extension, 'test-driver.html'), '<!doctype html><title>synthetic fixture driver</title>');
    browser = await chromium(extension);
    const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    const worker = await waitFor(async () => (await browser.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${extensionId}/background.js`), Boolean, 'extension worker');
    const driverTarget = await browser.send('Target.createTarget', {url: `chrome-extension://${extensionId}/test-driver.html`});
    const driver = await browser.attach(driverTarget.targetId);
    await waitFor(() => browser.evaluate(driver, '!!globalThis.chrome?.runtime?.sendMessage'), Boolean, 'extension test driver').catch(async error => {
      throw new Error(`${error.message}; driver=${JSON.stringify(await browser.evaluate(driver, '({url:location.href,title:document.title})'))}; worker=${worker.url}`);
    });
    const api = async (method, params = {}) => {
      const result = await browser.evaluate(driver, `chrome.runtime.sendMessage({type:'xwebmcp-api',method:${JSON.stringify(method)},params:${JSON.stringify(params)}})`);
      if (result.error) throw Object.assign(new Error(result.error.message), {code: result.error.code});
      return result.result;
    };
    const installed = await api('addCustomTools', {namespace: 'youtube.com', source: batch, force_overwrite_namespace: true});
    assert.equal(installed.tools.length, 7);
    assert.ok(installed.tools.every(tool => tool.kind === 'page'));
    assert.deepEqual(installed.pending_origins, []);
    let currentPolicy = policies.trusted_types;
    const posts = [], failures = [];
    const target = await browser.send('Target.createTarget', {url: 'about:blank'});
    const session = await browser.attach(target.targetId);
    const removeListener = browser.onEvent(message => {
      if (message.sessionId !== session || message.method !== 'Fetch.requestPaused') return;
      const {requestId, request} = message.params;
      (async () => {
        const url = new URL(request.url);
        let body, type;
        if (url.origin !== 'https://www.youtube.com') throw new Error('Unexpected fixture origin');
        if (url.pathname.startsWith('/youtubei/v1/')) {
          const input = JSON.parse(request.postData);
          assert.equal(request.method, 'POST');
          assert.deepEqual(Object.keys(input.context.client).sort(), ['clientName', 'clientVersion', 'gl', 'hl']);
          assert.ok(!Object.keys(request.headers).some(key => /cookie|authorization|x-goog/i.test(key)));
          posts.push({path: url.pathname, input});
          body = JSON.stringify(response(url.pathname, input)); type = 'application/json';
        } else if (url.pathname === '/fixture.js') { body = script; type = 'text/javascript'; }
        else if (url.pathname === '/favicon.ico') { body = ''; type = 'image/x-icon'; }
        else { body = html; type = 'text/html'; }
        await browser.send('Fetch.fulfillRequest', {requestId, responseCode: 200, responseHeaders: [{name: 'Content-Type', value: type}, {name: 'Content-Security-Policy', value: currentPolicy}], body: Buffer.from(body).toString('base64')}, session);
      })().catch(async error => {
        failures.push(error);
        await browser.send('Fetch.failRequest', {requestId, errorReason: 'BlockedByClient'}, session).catch(() => undefined);
      });
    });
    try {
      await browser.send('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]}, session);
      const tabId = await browser.evaluate(driver, `chrome.debugger.getTargets().then(targets => targets.find(target => target.id === ${JSON.stringify(target.targetId)}).tabId)`);
      const tools = () => api('listTools', {tab_id: tabId});
      const ready = () => waitFor(tools, entries => entries.filter(entry => entry.source.custom?.namespace === 'youtube.com').length === 7 && entries.some(entry => !entry.source.custom && entry.tool.name === 'search'), 'seven custom tools and synthetic native search').catch(async error => {
        throw new Error(`${error.message}; snapshot=${JSON.stringify(await api('tabSnapshot', {tab_id: tabId}))}`);
      });
      const invoke = async (entries, name, input) => {
        const item = entries.find(entry => entry.source.custom?.namespace === 'youtube.com' && entry.tool.name === name);
        const result = await api('invoke', {tool_ref: item.tool_ref, input, allow_user_tabs: true});
        assert.equal(result.status, 'completed');
        assert.ok(!JSON.stringify(result.output).includes('FABRICATED_SECRET'));
        return result.output;
      };
      for (const [policyName, policy] of Object.entries(policies)) {
        await t.test(policyName, async () => {
          currentPolicy = policy;
          await browser.send('Page.navigate', {url: `https://www.youtube.com/channel/${channelId}/videos?fixture=${policyName}`}, session);
          await waitFor(() => browser.evaluate(session, '!!window.fixtureReady'), Boolean, 'synthetic document');
          const refusal = await browser.evaluate(session, `(() => {try {new Function('return 1');return null;} catch(error) {return {name:error.name,message:error.message};}})()`, {allowUnsafeEvalBlockedByCSP: false});
          assert.ok(refusal, 'site policy must still refuse Function');
          assert.match(refusal.message, /Content Security Policy|Trusted Type assignment requirements|TrustedScript/);
          assert.equal(await browser.evaluate(session, 'trustedTypes.defaultPolicy'), null);
          const entries = await ready();
          assert.equal((await invoke(entries, 'search', {query: 'fabricated'})).results[0].video_id, videoId);
          assert.equal((await invoke(entries, 'get_video', {video: videoId})).video_id, videoId);
          assert.equal((await invoke(entries, 'get_channel', {channel_id: channelId})).channel_id, channelId);
          assert.equal((await invoke(entries, 'get_playlist', {playlist_id: playlistId})).items.length, 1);
          const videos = await invoke(entries, 'list_channel_videos', {channel_id: channelId});
          assert.equal(videos.next_page_token, token);
          assert.equal((await invoke(entries, 'list_channel_videos', {page_token: token})).channel_id, null);
          await browser.evaluate(session, `history.pushState(null,'','/watch?v=${videoId}')`);
          const transcript = await invoke(entries, 'get_transcript', {video_id: videoId, limit: 2});
          assert.equal(transcript.segments.length, 2); assert.equal(transcript.next_offset, 2);
          await browser.evaluate(session, `history.pushState(null,'','/channel/${channelId}/videos');fixture.config.LOGGED_IN=true`);
          const input = {channel_id: channelId, subscribed: true};
          const subscribed = await invoke(entries, 'set_subscription', input);
          assert.equal(subscribed.status, 'observed'); assert.equal(subscribed.persistence_confirmed, false);
          assert.equal((await invoke(entries, 'set_subscription', input)).action_attempted, false);
          assert.equal(await browser.evaluate(session, 'fixture.clicks'), 1);
          for (const name of names) await invoke(entries, name, {});
          const native = entries.find(entry => !entry.source.custom && entry.tool.name === 'search');
          assert.deepEqual((await api('invoke', {tool_ref: native.tool_ref, input: {}, allow_user_tabs: true})).output, {fixture_native: true});
          const attached = await browser.evaluate(driver, `chrome.debugger.getTargets().then(targets=>targets.find(target=>target.tabId===${tabId}).attached)`);
          // The test CDP client remains attached; check the extension's own attachment with a fresh attach/detach.
          assert.equal(attached, true);
          await browser.evaluate(driver, `chrome.debugger.attach({tabId:${tabId}},'1.3').then(()=>chrome.debugger.detach({tabId:${tabId}}))`);
        });
      }
      await t.test('page-supplied source is never used by the privileged fallback', async () => {
        const entries = await ready();
        const id = entries.find(entry => entry.source.custom?.namespace === 'youtube.com').source.custom.id;
        await browser.evaluate(session, `window.postMessage({source:'xwebmcp',type:'register-page-tools',definitions:[{id:${JSON.stringify(id)},name:'custom.forged.alias',tool:{name:'forged_alias',description:'synthetic forged metadata',inputSchema:{type:'object'}},pageExecuteSource:'(()=>{window.fixtureForgedSourceRan=true;return async()=>({});})()'}]},'*')`);
        await waitFor(() => api('tabSnapshot', {tab_id: tabId}), snapshot => snapshot.frames[0].registered.length === 7 && snapshot.frames[0].registrationErrors.length === 0, 'stored-source fallback acknowledgment');
        assert.equal(await browser.evaluate(session, 'window.fixtureForgedSourceRan === undefined'), true);
        assert.ok(!(await tools()).some(entry => entry.tool.name === 'forged_alias'));
      });
      await t.test('unrelated native TypeError fails without requesting privileged compilation', async () => {
        await browser.evaluate(session, `window.fixtureErrors=[];window.addEventListener('message',event=>{if(event.data?.source==='xwebmcp-page')fixtureErrors.push(event.data)});window.dispatchEvent(new MessageEvent('message',{source:window,data:{source:'xwebmcp',type:'register-page-tools',definitions:[{id:'ct_unrelated',name:'custom.ct_unrelated.x',tool:{name:'x'},pageExecuteSource:{toString(){return{}},valueOf(){return{}}}}]}}))`);
        const messages = await waitFor(() => browser.evaluate(session, 'fixtureErrors'), entries => entries.some(entry => entry.type === 'page-tools-error'), 'ordinary TypeError');
        assert.match(messages.find(entry => entry.type === 'page-tools-error').errors[0], /Cannot convert object to primitive value/);
        assert.ok(!messages.some(entry => entry.type === 'page-tools-csp' && entry.ids.includes('ct_unrelated')));
        assert.equal((await ready()).filter(entry => entry.source.custom).length, 7);
      });
      await t.test('an unavailable debugger fails closed without detaching its existing owner', async () => {
        await browser.evaluate(driver, `chrome.debugger.attach({tabId:${tabId}},'1.3')`);
        try {
          await api('addCustomTools', {namespace: 'youtube.com', source: batch, force_overwrite_namespace: true});
          const snapshot = await waitFor(() => api('tabSnapshot', {tab_id: tabId}), value => value.frames[0].registrationErrors.length === 7, 'debugger refusal');
          assert.ok(snapshot.frames[0].registrationErrors.every(error => /already attached|another debugger/i.test(error)));
          assert.equal((await tools()).filter(entry => entry.source.custom).length, 0);
          assert.equal(await browser.evaluate(driver, `chrome.debugger.getTargets().then(targets=>targets.find(target=>target.tabId===${tabId}).attached)`), true);
        } finally {
          await browser.evaluate(driver, `chrome.debugger.detach({tabId:${tabId}})`);
          await api('addCustomTools', {namespace: 'youtube.com', source: batch, force_overwrite_namespace: true});
          await ready();
        }
      });
      await t.test('atomic namespace replacement preserves native tools and retires old references', async () => {
        const before = await ready();
        const previous = before.find(entry => entry.source.custom?.namespace === 'youtube.com');
        await api('addCustomTools', {namespace: 'youtube.com', source: batch, force_overwrite_namespace: true});
        const after = await waitFor(tools, entries => entries.filter(entry => entry.source.custom?.namespace === 'youtube.com').length === 7 && !entries.some(entry => entry.tool_ref === previous.tool_ref), 'replacement namespace');
        assert.equal(after.filter(entry => !entry.source.custom && entry.tool.name === 'search').length, 1);
        await assert.rejects(api('invoke', {tool_ref: previous.tool_ref, input: {}, allow_user_tabs: true}), /no longer available/);
        await assert.rejects(api('addCustomTools', {namespace: 'youtube.com', source: batch}), /already exists/);
      });
      await t.test('a document replacement retires old references and registers on the new document', async () => {
        const before = await ready();
        const stale = before.find(entry => entry.source.custom?.namespace === 'youtube.com');
        const url = await browser.evaluate(session, 'location.href');
        await browser.send('Page.navigate', {url}, session);
        await waitFor(tools, entries => entries.filter(entry => entry.source.custom?.namespace === 'youtube.com').length === 7 && !entries.some(entry => entry.tool_ref === stale.tool_ref), 'new document registrations');
        await assert.rejects(api('invoke', {tool_ref: stale.tool_ref, input: {}, allow_user_tabs: true}), /no longer available/);
        assert.equal((await ready()).filter(entry => entry.source.custom).length, 7);
      });
      assert.equal(failures.length, 0, failures.map(error => error.stack).join('\n'));
      assert.ok(posts.length > 0);
    } finally {
      removeListener();
      await browser.send('Target.closeTarget', {targetId: target.targetId});
    }
  } finally {
    await browser?.close();
    await rm(extension, {recursive: true, force: true});
  }
});
