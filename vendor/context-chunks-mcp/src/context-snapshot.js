// Portable request-local archive. No filesystem, process cache, embeddings or LLM.
const escape = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
export const contextPointer = (parent, key) => `${parent}/${escape(key)}`;

/** A verbatim excerpt, not an inferred summary. Keep short corrections intact. */
export function contextLabel(value, { maxWords = 5, maxChars = 100 } = {}) {
  if (!Number.isSafeInteger(maxWords) || maxWords < 1 || !Number.isSafeInteger(maxChars) || maxChars < 8) {
    throw new RangeError('Invalid excerpt limits');
  }
  if (typeof value !== 'string') {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array (${value.length} items)`;
    if (typeof value === 'object') {
      if (typeof value.role === 'string') {
        const content = typeof value.content === 'string' ? value.content : Array.isArray(value.content)
          ? value.content.filter(p => p?.type === 'text').map(p => p.text || '').join(' ') : '';
        const names = (Array.isArray(value.tool_calls) ? value.tool_calls : []).map(c => c.function?.name).filter(Boolean);
        return `${value.role}: ${contextLabel(content || names.join(', ') || 'message', { maxWords, maxChars: Math.max(8, maxChars - value.role.length - 2) })}`.slice(0, maxChars);
      }
      return `object (${Object.keys(value).slice(0, maxWords).join(', ')})`.slice(0, maxChars);
    }
    return String(value).slice(0, maxChars);
  }
  // Only inspect a bounded prefix of a giant string. Never tokenize an entire tool dump.
  const sample = value.slice(0, maxChars * 8), text = sample.replace(/\s+/gu, ' ').trim();
  const incomplete = sample.length < value.length;
  if (!incomplete && text.length <= maxChars && text.split(' ').length <= 12) return text;
  const words = text.split(' ').slice(0, maxWords).join(' ');
  const prefix = words.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/u, '');
  return incomplete || prefix.length < text.length ? `${prefix}…` : prefix;
}

export function createContextSnapshot(request) {
  // JSON roundtrip both isolates the caller and fixes the exact serializable source version.
  const serialized = JSON.stringify(request);
  if (serialized === undefined) throw new TypeError('Serializable request required');
  const root = JSON.parse(serialized);
  const scope = crypto.randomUUID();
  const paths = new Map(), ids = new Map();
  let closed = false;
  const open = () => { if (closed) throw new Error('Context snapshot closed'); };
  const valueAt = path => {
    if (path === '') return root;
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('JSON pointer required');
    let value = root;
    for (const segment of path.slice(1).split('/')) {
      if (/~(?![01])/u.test(segment)) throw new TypeError('Invalid JSON pointer escape');
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('Unknown context path');
      value = value[key];
    }
    return value;
  };
  const ref = (path = '') => {
    open();
    valueAt(path);
    if (!paths.has(path)) {
      const id = `ctx:${scope}:${paths.size.toString(36)}`;
      paths.set(path, id); ids.set(id, path);
    }
    return paths.get(path);
  };
  const pathFor = id => {
    open();
    if (typeof id !== 'string' || !ids.has(id)) throw new Error('Unknown context ref for this request');
    return ids.get(id);
  };
  const resolve = id => structuredClone(valueAt(pathFor(id)));
  const read = (id, { offset = 0, limit = 15000, mode = 'value' } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 2 || limit > 15000) {
      throw new RangeError('offset must be nonnegative; limit must be 2..15000');
    }
    if (mode !== 'value' && mode !== 'key') throw new RangeError('Unknown read mode');
    const path = pathFor(id);
    if (mode === 'key' && path === '') throw new RangeError('Root has no key');
    const value = mode === 'key' ? path.slice(path.lastIndexOf('/') + 1).replace(/~1/g, '/').replace(/~0/g, '~') : valueAt(path);
    if (typeof value === 'string') {
      if (offset > value.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(value[offset] || '') && /[\uD800-\uDBFF]/u.test(value[offset - 1]))) {
        throw new RangeError('Invalid string offset');
      }
      let end = Math.min(value.length, offset + limit);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end])) end--;
      return { ref: id, mode, type: 'string', offset, total: value.length, text: value.slice(offset, end), nextOffset: end < value.length ? end : null };
    }
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      if (offset > keys.length) throw new RangeError('Invalid collection offset');
      // Navigation is paged too. Always emit one entry so small limits still progress.
      const items = []; let end = offset, size = 0;
      while (end < keys.length && items.length < 100) {
        const key = keys[end], child = value[key];
        const keyPreview = key.length > 100 ? `${key.slice(0, 99).replace(/[\uD800-\uDBFF]$/u, '')}…` : key;
        const item = { key: keyPreview, ref: ref(contextPointer(path, key)), label: contextLabel(child),
          ...(key.length > 100 ? { keyTruncated: true, keyLength: key.length } : {}) };
        const chars = JSON.stringify(item).length;
        if (items.length && size + chars > limit) break;
        items.push(item); size += chars; end++;
      }
      return { ref: id, mode, type: Array.isArray(value) ? 'array' : 'object', offset, total: keys.length, items, nextOffset: end < keys.length ? end : null };
    }
    if (offset !== 0) throw new RangeError('Scalar offset must be zero');
    return { ref: id, mode, type: value === null ? 'null' : typeof value, value, nextOffset: null };
  };
  return { scope, serialized, ref, resolve, read, close() { closed = true; paths.clear(); ids.clear(); } };
}
