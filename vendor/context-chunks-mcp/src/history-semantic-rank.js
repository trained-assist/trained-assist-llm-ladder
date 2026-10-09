// Semantic retrieval over message history; no implicit embedding API or model dependency.
// Caller supplies vectors, or an injected embedder. Retrieval does not mutate messages.
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) throw new TypeError('Embedding dimensions must match');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new TypeError('Embedding values must be finite');
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  if (!aa || !bb) throw new TypeError('Zero-norm embedding');
  return dot / Math.sqrt(aa * bb);
}

export function rankHistory(queryVector, history, {
  maxAgePenalty = 0.2, minSimilarity = 0, limit = 10,
  excludeIds = [], latestSequence = null
} = {}) {
  if (!Array.isArray(history)) throw new TypeError('history must be an array');
  if (!(maxAgePenalty >= 0 && maxAgePenalty < 1)) throw new RangeError('maxAgePenalty must be between 0 and 1');
  if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1) throw new RangeError('minSimilarity must be between -1 and 1');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be nonnegative integer');
  const excluded = new Set(excludeIds);
  const eligible = history.filter(m => !excluded.has(m.id));
  const sequences = eligible.map(m => m.sequence);
  if (sequences.some(s => !Number.isSafeInteger(s) || s < 0)) throw new TypeError('Each message requires nonnegative integer sequence');
  if (new Set(sequences).size !== sequences.length) throw new Error('Duplicate sequence');
  const newest = latestSequence ?? Math.max(0, ...sequences);
  if (!Number.isSafeInteger(newest) || newest < 0 || sequences.some(s => s > newest)) throw new RangeError('Invalid latestSequence');
  const oldest = Math.min(newest, ...sequences);
  const span = Math.max(1, newest - oldest);
  return eligible.map(m => {
    const similarity = cosineSimilarity(queryVector, m.vector);
    const age = (newest - m.sequence) / span;
    const recencyFactor = 1 - maxAgePenalty * age;
    // Negative similarities must not be promoted by a recency multiplier.
    const score = similarity >= 0 ? similarity * recencyFactor : similarity / recencyFactor;
    return {id:m.id, sequence:m.sequence, similarity, recencyFactor, score, ref:m.ref ?? null};
  }).filter(m => m.similarity >= minSimilarity)
    .sort((a,b) => b.score-a.score || b.similarity-a.similarity || b.sequence-a.sequence || String(a.id).localeCompare(String(b.id)))
    .slice(0,limit);
}

// Explicit embedding provider, model-versioned cache and source-level refs.
// Keep message/part boundaries in the upstream hierarchy; no text concatenation.
export async function buildHistoryEmbeddings(messages, {embed, modelId, cache = new Map()} = {}) {
  if (typeof embed !== 'function' || !modelId) throw new TypeError('embed function and modelId are required');
  const result = [];
  for (const m of messages) {
    if (typeof m.text !== 'string' || !m.text.trim()) continue;
    if (m.id == null || !Number.isSafeInteger(m.sequence)) throw new TypeError('message id and sequence required');
    const key = JSON.stringify([modelId,m.id,m.text]);
    let vector = cache.get(key);
    if (!vector) { vector = await embed(m.text); cache.set(key,vector); }
    result.push({id:m.id,sequence:m.sequence,ref:m.ref??null,vector});
  }
  return result;
}

export async function searchHistory(queryText, messages, {embed, modelId, cache = new Map(), ...rankOptions} = {}) {
  if (typeof queryText !== 'string' || !queryText.trim()) throw new TypeError('queryText required');
  const vectors = await buildHistoryEmbeddings(messages,{embed,modelId,cache});
  const queryVector = await embed(queryText);
  return rankHistory(queryVector,vectors,rankOptions);
}
