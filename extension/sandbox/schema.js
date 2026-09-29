// A small JSON Schema validator covering the keywords tool files use. It
// mirrors what the Kernel executor enforces with Ajv: inputs are rejected
// before a tool runs and outputs are rejected after it returns.

(() => {
  globalThis.xw ??= {};

  function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function matchesType(value, type) {
    const actual = typeOf(value);
    if (type === 'integer') return actual === 'number' && Number.isInteger(value);
    if (type === 'number') return actual === 'number' && Number.isFinite(value);
    return actual === type;
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeOf(a) !== typeOf(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
    if (typeOf(a) === 'object') {
      const keys = Object.keys(a);
      return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]));
    }
    return false;
  }

  function isSchemaObject(schema) {
    return schema !== null && typeof schema === 'object' && !Array.isArray(schema);
  }

  function validateNode(schema, value, path, errors) {
    if (schema === true || schema === undefined) return;
    if (schema === false) {
      errors.push(`${path || 'value'} is not allowed`);
      return;
    }
    if (!isSchemaObject(schema)) return;

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => matchesType(value, type))) {
        errors.push(`${path || 'value'} must be ${types.join(' or ')}`);
        return;
      }
    }
    if (schema.const !== undefined && !deepEqual(value, schema.const)) {
      errors.push(`${path || 'value'} must be equal to constant ${JSON.stringify(schema.const)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(value, option))) {
      errors.push(`${path || 'value'} must be equal to one of the allowed values`);
    }

    if (typeof value === 'string') {
      if (schema.minLength !== undefined && [...value].length < schema.minLength) {
        errors.push(`${path || 'value'} must NOT have fewer than ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
        errors.push(`${path || 'value'} must NOT have more than ${schema.maxLength} characters`);
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
        errors.push(`${path || 'value'} must match pattern "${schema.pattern}"`);
      }
    }

    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path || 'value'} must be >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path || 'value'} must be <= ${schema.maximum}`);
      }
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
        errors.push(`${path || 'value'} must be > ${schema.exclusiveMinimum}`);
      }
      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
        errors.push(`${path || 'value'} must be < ${schema.exclusiveMaximum}`);
      }
      if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) {
        errors.push(`${path || 'value'} must be multiple of ${schema.multipleOf}`);
      }
    }

    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path || 'value'} must NOT have fewer than ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path || 'value'} must NOT have more than ${schema.maxItems} items`);
      }
      if (schema.uniqueItems && value.some((item, i) => value.slice(0, i).some((other) => deepEqual(item, other)))) {
        errors.push(`${path || 'value'} must NOT have duplicate items`);
      }
      if (Array.isArray(schema.prefixItems)) {
        schema.prefixItems.forEach((itemSchema, i) => {
          if (i < value.length) validateNode(itemSchema, value[i], `${path}/${i}`, errors);
        });
      }
      if (schema.items !== undefined) {
        const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
        for (let i = start; i < value.length; i++) validateNode(schema.items, value[i], `${path}/${i}`, errors);
      }
      if (schema.contains !== undefined && !value.some((item) => validate(schema.contains, item).valid)) {
        errors.push(`${path || 'value'} must contain at least 1 valid item(s)`);
      }
    }

    if (typeOf(value) === 'object') {
      const keys = Object.keys(value);
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) {
            errors.push(`${path || 'value'} must have required property '${key}'`);
          }
        }
      }
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
        errors.push(`${path || 'value'} must NOT have fewer than ${schema.minProperties} properties`);
      }
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        errors.push(`${path || 'value'} must NOT have more than ${schema.maxProperties} properties`);
      }
      const properties = isSchemaObject(schema.properties) ? schema.properties : {};
      const patternProperties = isSchemaObject(schema.patternProperties) ? schema.patternProperties : {};
      for (const key of keys) {
        let covered = false;
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          covered = true;
          validateNode(properties[key], value[key], `${path}/${key}`, errors);
        }
        for (const [pattern, subschema] of Object.entries(patternProperties)) {
          if (new RegExp(pattern, 'u').test(key)) {
            covered = true;
            validateNode(subschema, value[key], `${path}/${key}`, errors);
          }
        }
        if (!covered && schema.additionalProperties !== undefined) {
          if (schema.additionalProperties === false) {
            errors.push(`${path || 'value'} must NOT have additional properties (${key})`);
          } else {
            validateNode(schema.additionalProperties, value[key], `${path}/${key}`, errors);
          }
        }
        if (schema.propertyNames !== undefined) {
          validateNode(schema.propertyNames, key, `${path}/${key}`, errors);
        }
      }
      if (isSchemaObject(schema.dependentRequired)) {
        for (const [key, deps] of Object.entries(schema.dependentRequired)) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            for (const dep of deps) {
              if (!Object.prototype.hasOwnProperty.call(value, dep)) {
                errors.push(`${path || 'value'} must have property ${dep} when property ${key} is present`);
              }
            }
          }
        }
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const subschema of schema.allOf) validateNode(subschema, value, path, errors);
    }
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((subschema) => validate(subschema, value).valid)) {
      errors.push(`${path || 'value'} must match a schema in anyOf`);
    }
    if (Array.isArray(schema.oneOf)) {
      const passing = schema.oneOf.filter((subschema) => validate(subschema, value).valid).length;
      if (passing !== 1) errors.push(`${path || 'value'} must match exactly one schema in oneOf`);
    }
    if (schema.not !== undefined && validate(schema.not, value).valid) {
      errors.push(`${path || 'value'} must NOT be valid`);
    }
    if (schema.if !== undefined) {
      const branch = validate(schema.if, value).valid ? schema.then : schema.else;
      if (branch !== undefined) validateNode(branch, value, path, errors);
    }
  }

  function validate(schema, value) {
    const errors = [];
    validateNode(schema, value, '', errors);
    return {valid: errors.length === 0, errors, errorMessage: errors.join(', ')};
  }

  // compile mirrors Ajv's failure mode: schemas that are not objects are
  // rejected up front so a tool with a broken schema is refused at install time.
  function compile(schema, field) {
    if (!isSchemaObject(schema)) {
      throw new Error(`${field} is not a compilable JSON Schema: expected an object`);
    }
    for (const key of ['pattern']) {
      if (schema[key] !== undefined) {
        try {
          new RegExp(schema[key], 'u');
        } catch (error) {
          throw new Error(`${field} is not a compilable JSON Schema: ${error.message}`);
        }
      }
    }
    return (value) => validate(schema, value);
  }

  globalThis.xw.schema = {validate, compile};
})();
