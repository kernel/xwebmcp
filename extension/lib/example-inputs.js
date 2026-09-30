// AI-generated example inputs for a WebMCP tool, via OpenRouter. Only the
// tool's name, description, and inputSchema plus the page title/url and the
// user's optional task are sent. The API key goes only to OpenRouter and is
// never logged.

(() => {
  globalThis.xw ??= {};

  const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
  const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
  const SETTINGS_KEY = 'openrouter';

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  function buildMessages({tool, page, task}) {
    const system = [
      'You generate example inputs for a WebMCP tool that runs on a web page.',
      'Reply with ONLY one JSON object that conforms exactly to the given JSON Schema: no prose, no code fences.',
      'Include every required property, use only declared properties when additionalProperties is false, respect enum/const/format/min/max.',
      'Prefer realistic values that fit the page. Dates should be in the future relative to today.',
    ].join(' ');
    const user = {
      today: new Date().toISOString().slice(0, 10),
      page: {title: page?.title ?? '', url: page?.url ?? ''},
      tool: {name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? {type: 'object', properties: {}}},
      ...(task && task.trim() ? {task: `Choose inputs that accomplish this user goal: ${task.trim()}`} : {}),
    };
    return [{role: 'system', content: system}, {role: 'user', content: JSON.stringify(user, null, 2)}];
  }

  // extractJSON parses the model reply, tolerating code fences or stray prose
  // around a single object.
  function extractJSON(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('the model returned an empty reply');
    let body = text.trim();
    const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) body = fence[1].trim();
    try {
      return JSON.parse(body);
    } catch {
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(body.slice(start, end + 1));
        } catch {
          // fall through
        }
      }
      throw new Error('the model reply was not valid JSON');
    }
  }

  function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value;
  }

  function typeMatches(value, type) {
    const actual = typeOf(value);
    return actual === type || (type === 'number' && actual === 'integer');
  }

  // validateSchema checks a practical subset of JSON Schema and returns a
  // list of problems (empty when valid). The page remains the final validator.
  function validateSchema(value, schema, path = 'inputs', errors = []) {
    if (!isObject(schema)) return errors;
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => typeMatches(value, type))) {
        errors.push(`${path} must be ${types.join(' or ')}`);
        return errors;
      }
    }
    if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
      errors.push(`${path} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
    }
    for (const key of ['anyOf', 'oneOf']) {
      if (Array.isArray(schema[key])) {
        const matches = schema[key].filter((branch) => validateSchema(value, branch, path, []).length === 0).length;
        if (key === 'anyOf' ? matches === 0 : matches !== 1) errors.push(`${path} does not match ${key}`);
      }
    }
    if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) validateSchema(value, branch, path, errors);
    if (typeof value === 'string') {
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path} is too short`);
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path} is too long`);
      if (typeof schema.pattern === 'string') {
        try {
          if (!new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path} must match ${schema.pattern}`);
        } catch {
          // unsupported pattern; leave it to the page
        }
      }
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
      if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${path} must be > ${schema.exclusiveMinimum}`);
      if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push(`${path} must be < ${schema.exclusiveMaximum}`);
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
      if (isObject(schema.items)) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, errors));
    }
    if (isObject(value)) {
      const properties = isObject(schema.properties) ? schema.properties : {};
      for (const name of Array.isArray(schema.required) ? schema.required : []) {
        if (!Object.hasOwn(value, name)) errors.push(`${path}.${name} is required`);
      }
      for (const [name, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, name)) validateSchema(item, properties[name], `${path}.${name}`, errors);
        else if (schema.additionalProperties === false) errors.push(`${path}.${name} is not allowed`);
        else if (isObject(schema.additionalProperties)) validateSchema(item, schema.additionalProperties, `${path}.${name}`, errors);
      }
    }
    return errors;
  }

  async function callOpenRouter({apiKey, model, messages, fetchImpl = globalThis.fetch, signal}) {
    if (!apiKey) throw new Error('set an OpenRouter API key in settings first');
    const response = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'xwebmcp',
      },
      body: JSON.stringify({model: model || DEFAULT_MODEL, messages, response_format: {type: 'json_object'}, temperature: 0.4}),
      signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw new Error(`OpenRouter request failed: ${body?.error?.message ?? `HTTP ${response.status}`}`);
    const content = body?.choices?.[0]?.message?.content;
    const value = extractJSON(typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '');
    if (!isObject(value)) throw new Error('the model reply was not a JSON object');
    return value;
  }

  async function generateExampleInputs({apiKey, model, tool, page, task, fetchImpl, signal}) {
    const input = await callOpenRouter({apiKey, model, messages: buildMessages({tool, page, task}), fetchImpl, signal});
    const problems = validateSchema(input, tool.inputSchema ?? {type: 'object'});
    if (problems.length) throw new Error(`the generated inputs do not match the schema: ${problems.slice(0, 5).join('; ')}`);
    return input;
  }

  function buildStepMessages({task, page, tools, history}) {
    const system = [
      'You are driving WebMCP tools on a web page, one call at a time, for a human who reviews and runs each call.',
      'Given the task, the page, the available tools, and the recent invocation history (oldest first), choose the single best next tool call.',
      'Reply with ONLY a JSON object {"tool": "<exact tool name>", "arguments": {...}}: no prose, no code fences.',
      'arguments must conform exactly to that tool\'s inputSchema. Do not repeat a call that already succeeded unless needed.',
    ].join(' ');
    const user = {
      today: new Date().toISOString().slice(0, 10),
      task: task && task.trim() ? task.trim() : '(no task given; pick a sensible, safe, read-only next step)',
      page: {title: page?.title ?? '', url: page?.url ?? ''},
      tools: tools.map((tool) => ({name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? {type: 'object', properties: {}}})),
      history: (history ?? []).slice(-10),
    };
    return [{role: 'system', content: system}, {role: 'user', content: JSON.stringify(user, null, 2)}];
  }

  // planNextStep asks the model for the next tool call and returns
  // {tool, arguments} after checking the tool exists and the arguments match.
  async function planNextStep({apiKey, model, task, page, tools, history, fetchImpl, signal}) {
    const reply = await callOpenRouter({apiKey, model, messages: buildStepMessages({task, page, tools, history}), fetchImpl, signal});
    const name = reply.tool ?? reply.name ?? reply.tool_name;
    const args = reply.arguments ?? reply.args ?? reply.input ?? {};
    if (typeof name !== 'string' || !name) throw new Error('the model reply did not name a tool');
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`the model picked an unknown tool: ${name}`);
    if (!isObject(args)) throw new Error('the model arguments were not a JSON object');
    const problems = validateSchema(args, tool.inputSchema ?? {type: 'object'});
    if (problems.length) throw new Error(`arguments for ${name} do not match the schema: ${problems.slice(0, 5).join('; ')}`);
    return {tool: name, arguments: args};
  }

  globalThis.xw.examples = {OPENROUTER_URL, DEFAULT_MODEL, SETTINGS_KEY, buildMessages, buildStepMessages, extractJSON, validateSchema, generateExampleInputs, planNextStep};
})();
