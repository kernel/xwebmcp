// Schema-driven input forms for WebMCP tools, following the Kernel dashboard's
// rules: only flat object schemas of string/number/integer/boolean fields (with
// enum or anyOf-const options) get fields; anything else stays JSON, and the
// page remains the schema validator.

(() => {
  globalThis.xw ??= {};

  function isInputObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isFieldValue(value, type) {
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    return typeof value === type;
  }

  // getWebMCPFields returns the field list for a schema, or null when the
  // schema needs the JSON editor.
  function getWebMCPFields(schema) {
    if (!isInputObject(schema)) return null;
    if (schema.type !== 'object' || ['$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'not'].some((key) => key in schema)) {
      return null;
    }
    if (schema.properties !== undefined && !isInputObject(schema.properties)) return null;
    const fields = [];
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (!isInputObject(property) || ['$ref', 'allOf', 'oneOf'].some((key) => key in property)) return null;
      const type = property.type;
      if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') return null;
      let options;
      if ('anyOf' in property) {
        if (!Array.isArray(property.anyOf)) return null;
        options = [];
        for (const branch of property.anyOf) {
          if (
            !isInputObject(branch) ||
            Object.keys(branch).some((key) => !['const', 'title', 'description', 'type'].includes(key)) ||
            !isFieldValue(branch.const, type) ||
            (branch.type !== undefined && branch.type !== type)
          ) {
            return null;
          }
          options.push({value: branch.const, label: typeof branch.title === 'string' ? branch.title : String(branch.const)});
        }
      }
      if (Array.isArray(property.enum)) {
        const values = property.enum;
        options = options
          ? options.filter((option) => values.includes(option.value))
          : values.filter((value) => isFieldValue(value, type)).map((value) => ({value, label: String(value)}));
      }
      fields.push({
        ...(options ? {options} : {}),
        name,
        type,
        description: typeof property.description === 'string' ? property.description : undefined,
        required: Array.isArray(schema.required) && schema.required.includes(name),
      });
    }
    return fields;
  }

  // canDisplayWebMCPFields reports whether the current input only uses values
  // the fields can show.
  function canDisplayWebMCPFields(fields, input) {
    return Object.entries(input).every(([name, value]) => {
      const field = fields.find((candidate) => candidate.name === name);
      return (
        field &&
        typeof value === (field.type === 'integer' ? 'number' : field.type) &&
        (!field.options || field.options.some((option) => option.value === value))
      );
    });
  }

  // parseWebMCPInput parses the JSON draft, applying the numeric fields that
  // are still being typed, and enforces the 1 MiB input limit.
  function parseWebMCPInput(text, numbers) {
    const parsed = JSON.parse(text);
    if (!isInputObject(parsed)) throw new Error('inputs must be a JSON object');
    const entries = new Map(Object.entries(parsed));
    for (const [name, raw] of Object.entries(numbers ?? {})) {
      if (!raw.trim()) {
        entries.delete(name);
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
      entries.set(name, value);
    }
    const input = Object.fromEntries(entries);
    if (new TextEncoder().encode(JSON.stringify(input)).length > 1024 * 1024) {
      throw new Error('inputs must be smaller than 1 MiB');
    }
    return input;
  }

  globalThis.xw.inputs = {getWebMCPFields, canDisplayWebMCPFields, parseWebMCPInput};
})();
