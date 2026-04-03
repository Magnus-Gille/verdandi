/**
 * RFC 8785 JSON Canonicalization Scheme implementation.
 * Resolves debate critique C01: the original JSON.stringify with sorted keys
 * was broken — it dropped nested object keys.
 *
 * This implementation recursively sorts all object keys and produces
 * deterministic byte-level output per RFC 8785.
 */

export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${value}`);
    }
    // RFC 8785 §3.2.2.3: use ECMAScript Number serialization
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    // RFC 8785 §3.2.2.2: use ECMAScript string serialization (JSON.stringify handles escaping)
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map(item => canonicalize(item));
    return '[' + items.join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys
      .filter(key => obj[key] !== undefined) // RFC 8785: undefined values are omitted
      .map(key => JSON.stringify(key) + ':' + canonicalize(obj[key]));
    return '{' + pairs.join(',') + '}';
  }

  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}
