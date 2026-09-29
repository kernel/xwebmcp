import assert from 'node:assert/strict';
import test from 'node:test';

await import('./webmcp-inputs.js');
const {getWebMCPFields, canDisplayWebMCPFields, parseWebMCPInput} = globalThis.xw.inputs;

test('flat object schemas become fields', () => {
  const fields = getWebMCPFields({
    type: 'object',
    required: ['origin'],
    properties: {
      origin: {type: 'string', description: 'IATA code'},
      passengers: {type: 'integer', minimum: 1},
      tripType: {type: 'string', enum: ['oneway', 'roundtrip']},
      cabin: {type: 'string', anyOf: [{const: 'economy', title: 'Economy'}, {const: 'first'}]},
      nonstop: {type: 'boolean'},
    },
  });
  assert.deepEqual(fields.map((field) => [field.name, field.type, field.required]), [
    ['origin', 'string', true],
    ['passengers', 'integer', false],
    ['tripType', 'string', false],
    ['cabin', 'string', false],
    ['nonstop', 'boolean', false],
  ]);
  assert.deepEqual(fields[2].options, [{value: 'oneway', label: 'oneway'}, {value: 'roundtrip', label: 'roundtrip'}]);
  assert.deepEqual(fields[3].options, [{value: 'economy', label: 'Economy'}, {value: 'first', label: 'first'}]);
  assert.equal(fields[0].description, 'IATA code');
});

test('complex schemas stay in JSON mode', () => {
  assert.equal(getWebMCPFields({type: 'object', oneOf: [{required: ['a']}]}), null);
  assert.equal(getWebMCPFields({type: 'object', properties: {list: {type: 'array'}}}), null);
  assert.equal(getWebMCPFields({type: 'object', properties: {ref: {$ref: '#/x'}}}), null);
  assert.equal(getWebMCPFields({type: 'string'}), null);
  assert.equal(getWebMCPFields(null), null);
  assert.deepEqual(getWebMCPFields({type: 'object'}), []);
});

test('fields can only display values they understand', () => {
  const fields = getWebMCPFields({type: 'object', properties: {n: {type: 'integer'}, t: {type: 'string', enum: ['a']}}});
  assert.equal(canDisplayWebMCPFields(fields, {n: 3, t: 'a'}), true);
  assert.equal(canDisplayWebMCPFields(fields, {n: 'x'}), false);
  assert.equal(canDisplayWebMCPFields(fields, {t: 'b'}), false);
  assert.equal(canDisplayWebMCPFields(fields, {other: 1}), false);
});

test('parseWebMCPInput applies pending numbers and rejects non-objects', () => {
  assert.deepEqual(parseWebMCPInput('{"a":1}', {b: '2.5', c: ''}), {a: 1, b: 2.5});
  assert.throws(() => parseWebMCPInput('[1]'), /JSON object/);
  assert.throws(() => parseWebMCPInput('{}', {b: 'x'}), /finite number/);
});
