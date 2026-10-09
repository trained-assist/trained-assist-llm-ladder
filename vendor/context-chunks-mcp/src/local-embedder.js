/**
 * Local deterministic embedder - no API, no model download.
 * Uses hashed bag-of-words with TF-IDF-like weighting.
 * 
 * This is a lightweight proxy for a real embedding model.
 * It captures lexical overlap well; for semantic synonyms, inject a real embedder.
 */

const DIM = 256;

function hashToken(token) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % DIM;
}

function tokenize(text) {
  if (typeof text !== 'string') return [];
  return (text.toLowerCase().match(/[a-zа-яё0-9_]+/gi) || []);
}

export function createLocalEmbedder(opts = {}) {
  const dim = opts.dim || DIM;
  
  // Pre-compute IDF from a corpus if provided
  const idf = new Map();
  if (opts.corpus && opts.corpus.length) {
    const df = new Map();
    for (const doc of opts.corpus) {
      const seen = new Set(tokenize(doc));
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const N = opts.corpus.length;
    for (const [t, c] of df) {
      idf.set(t, Math.log((N + 1) / (c + 1)) + 1);
    }
  }
  
  return function embed(text) {
    const vec = new Float64Array(dim);
    const tokens = tokenize(text);
    
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    
    for (const [t, count] of tf) {
      const weight = count * (idf.get(t) || 1);
      vec[hashToken(t) % dim] += weight;
    }
    
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) vec[i] /= norm;
    }
    
    return Array.from(vec);
  };
}

export function createTfidfEmbedder(corpus) {
  return createLocalEmbedder({ corpus });
}