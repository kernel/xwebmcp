import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({URL, TextEncoder, JSON, Date, RegExp});
context.globalThis = context;
vm.runInContext(readFileSync(new URL('./example-inputs.js', import.meta.url), 'utf8'), context);
const {extractJSON, validateSchema, buildMessages, generateExampleInputs, OPENROUTER_URL} = context.xw.examples;

const schema = {type: 'object', properties: {from: {type: 'string', minLength: 3}, stops: {type: 'integer', enum: [0, 1]}}, required: ['from'], additionalProperties: false};
const tool = {name: 'search_flights', description: 'find flights', inputSchema: schema};

test('extractJSON tolerates fences and prose', () => {
  assert.equal(extractJSON('```json\n{"a":1}\n```').a, 1);
  assert.equal(extractJSON('here: {"a":2} ok').a, 2);
  assert.throws(() => extractJSON('nope'), /not valid JSON/);
});

test('validateSchema reports problems', () => {
  assert.equal(validateSchema({from: 'JFK', stops: 0}, schema).length, 0);
  const errors = validateSchema({stops: 2, extra: true}, schema);
  assert.ok(errors.some((e) => e.includes('from is required')));
  assert.ok(errors.some((e) => e.includes('one of')));
  assert.ok(errors.some((e) => e.includes('not allowed')));
});

test('buildMessages includes task and page but nothing else', () => {
  const messages = buildMessages({tool, page: {title: 'Delta', url: 'https://delta.com/'}, task: 'nonstop JFK to LAX'});
  const user = JSON.parse(messages[1].content);
  assert.deepEqual(Object.keys(user).sort(), ['page', 'task', 'today', 'tool']);
  assert.match(user.task, /nonstop JFK to LAX/);
});

test('generateExampleInputs posts to OpenRouter only and validates', async () => {
  const calls = [];
  const reply = (content, ok = true) => async (url, init) => {
    calls.push({url, init});
    return {ok, status: ok ? 200 : 401, json: async () => ok ? {choices: [{message: {content}}]} : {error: {message: 'bad key'}}};
  };
  const input = await generateExampleInputs({apiKey: 'k', model: 'm', tool, page: {}, task: '', fetchImpl: reply('{"from":"JFK","stops":0}')});
  assert.equal(input.from, 'JFK');
  assert.equal(calls[0].url, OPENROUTER_URL);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.ok(!calls[0].init.body.includes('"k"'));
  await assert.rejects(generateExampleInputs({apiKey: 'k', tool, page: {}, fetchImpl: reply('{"stops":3}')}), /do not match the schema/);
  await assert.rejects(generateExampleInputs({apiKey: 'k', tool, page: {}, fetchImpl: reply('', false)}), /bad key/);
  await assert.rejects(generateExampleInputs({apiKey: '', tool, page: {}, fetchImpl: reply('{}')}), /API key/);
});

test('planNextStep returns a known tool with valid arguments and sends history', async () => {
  let sent;
  const fetchImpl = (content) => async (url, init) => {
    sent = JSON.parse(init.body);
    return {ok: true, status: 200, json: async () => ({choices: [{message: {content}}]})};
  };
  const tools = [tool, {name: 'read_page', inputSchema: {type: 'object', properties: {}}}];
  const history = Array.from({length: 12}, (_, i) => ({tool: 'read_page', input: {}, status: 'completed', output: String(i)}));
  const plan = await context.xw.examples.planNextStep({apiKey: 'k', task: 'JFK', page: {}, tools, history, fetchImpl: fetchImpl('{"tool":"search_flights","arguments":{"from":"JFK"}}')});
  assert.equal(plan.tool, 'search_flights');
  assert.equal(plan.arguments.from, 'JFK');
  const user = JSON.parse(sent.messages[1].content);
  assert.equal(user.history.length, 10);
  assert.equal(user.tools.length, 2);
  await assert.rejects(context.xw.examples.planNextStep({apiKey: 'k', tools, history: [], fetchImpl: fetchImpl('{"tool":"nope","arguments":{}}')}), /unknown tool/);
  await assert.rejects(context.xw.examples.planNextStep({apiKey: 'k', tools, history: [], fetchImpl: fetchImpl('{"tool":"search_flights","arguments":{}}')}), /do not match/);
});
