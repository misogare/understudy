// Minimal JSON-Schema subset validator — zero-dependency.
// Covers the subset observed in real Claude Code workflow scripts:
// type, properties, required, additionalProperties, items, enum, const,
// anyOf/oneOf, string/number/array bounds, pattern, integer.
// Unknown keywords are ignored (permissive), matching how schemas are
// used for structured output rather than strict contract enforcement.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'object', 'string', 'number', 'boolean'
}

function checkType(expected, v) {
  const t = typeOf(v);
  if (expected === 'integer') return t === 'number' && Number.isInteger(v);
  if (expected === 'number') return t === 'number';
  return t === expected;
}

export function validate(schema, value, path = '$', errors = []) {
  if (schema == null || typeof schema !== 'object') return errors;

  if (schema.enum) {
    if (!schema.enum.some((e) => deepEqual(e, value))) {
      errors.push(`${path}: value ${short(value)} not in enum [${schema.enum.map(short).join(', ')}]`);
      return errors;
    }
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: expected const ${short(schema.const)}`);
    return errors;
  }

  const variants = schema.anyOf || schema.oneOf;
  if (Array.isArray(variants)) {
    const ok = variants.some((s) => validate(s, value, path, []).length === 0);
    if (!ok) errors.push(`${path}: value ${short(value)} matches none of the ${variants.length} allowed variants`);
    return errors;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => checkType(t, value))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)} (${short(value)})`);
      return errors; // no point checking deeper on a type mismatch
    }
  }

  if (typeOf(value) === 'string') {
    if (schema.minLength != null && value.length < schema.minLength)
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength)
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value))
          errors.push(`${path}: string does not match pattern ${schema.pattern}`);
      } catch { /* invalid pattern in schema — ignore */ }
    }
  }

  if (typeOf(value) === 'number') {
    if (schema.minimum != null && value < schema.minimum)
      errors.push(`${path}: ${value} below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum)
      errors.push(`${path}: ${value} above maximum ${schema.maximum}`);
  }

  if (typeOf(value) === 'array') {
    if (schema.minItems != null && value.length < schema.minItems)
      errors.push(`${path}: array has ${value.length} items, fewer than minItems ${schema.minItems}`);
    if (schema.maxItems != null && value.length > schema.maxItems)
      errors.push(`${path}: array has ${value.length} items, more than maxItems ${schema.maxItems}`);
    if (schema.items) {
      value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
    }
  }

  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (k in props) validate(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false)
        errors.push(`${path}: unexpected property "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        validate(schema.additionalProperties, v, `${path}.${k}`, errors);
    }
  }

  return errors;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (typeOf(a) === 'array') return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeOf(a) === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function short(v) {
  const s = JSON.stringify(v);
  return s == null ? String(v) : s.length > 60 ? s.slice(0, 57) + '...' : s;
}

// Generate a minimal instance satisfying a schema (used by the mock provider
// for keyless dry runs of workflow structure).
export function mockInstance(schema, depth = 0) {
  if (schema == null || typeof schema !== 'object' || depth > 8) return null;
  if (schema.enum) return schema.enum[0];
  if ('const' in schema) return schema.const;
  const variants = schema.anyOf || schema.oneOf;
  if (Array.isArray(variants) && variants.length) return mockInstance(variants[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string': return 'mock';
    case 'number': case 'integer': return schema.minimum ?? 0;
    case 'boolean': return false;
    case 'null': return null;
    case 'array': {
      const n = schema.minItems ?? 0;
      return Array.from({ length: n }, () => mockInstance(schema.items || {}, depth + 1));
    }
    case 'object': default: {
      const out = {};
      for (const req of schema.required || []) {
        out[req] = mockInstance((schema.properties || {})[req] || { type: 'string' }, depth + 1);
      }
      return out;
    }
  }
}
