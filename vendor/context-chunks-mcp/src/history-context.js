import { createLocalEmbedder } from './local-embedder.js';
import { rankHistory } from './history-semantic-rank.js';
import { createContextSnapshot, contextLabel } from './context-snapshot.js';

export function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content
    .filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  return '';
}

/** The five most recent users are guaranteed; up to five older semantic matches are retained. */
export function selectHistoryContext(messages, {
  historyTopK = 5, recentUserCount = 5, maxAgePenalty = 0.1, minSimilarity = -0.05, embed = null,
  snapshot = createContextSnapshot({ messages }),
} = {}) {
  if (!Number.isSafeInteger(historyTopK) || historyTopK < 0) throw new RangeError('historyTopK must be nonnegative');
  if (!Number.isSafeInteger(recentUserCount) || recentUserCount < 0) throw new RangeError('recentUserCount must be nonnegative');
  const users = messages.flatMap((m, i) => m.role === 'user'
    ? [{ id: `msg-${i}`, sequence: i, text: messageText(m), ref: snapshot.ref(`/messages/${i}`), label: contextLabel(messageText(m)) || 'user message' }]
    : []);
  const query = users.at(-1) ?? null, history = users.slice(0, -1);
  const recentHistoricalCount = Math.max(0, recentUserCount - (query ? 1 : 0));
  const recentUsers = recentHistoricalCount > 0 ? history.slice(-recentHistoricalCount) : [];
  const recentIds = new Set(recentUsers.map(m => m.id));
  const olderHistory = history.filter(m => !recentIds.has(m.id));
  const embedder = embed || createLocalEmbedder({ corpus: users.map(m => m.text) });
  const valid = v => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite) && v.some(n => Math.abs(n) > 1e-10);
  const queryVector = query ? embedder(query.text) : null;
  const candidates = olderHistory.map(m => ({ ...m, vector: embedder(m.text) })).filter(m => valid(m.vector));
  const fallback = !valid(queryVector) || candidates.length === 0;
  const ranked = fallback ? [] : rankHistory(queryVector, candidates, {
    maxAgePenalty, minSimilarity, limit: historyTopK, latestSequence: query.sequence,
  });
  const chosen = new Set([...recentIds, ...ranked.map(m => m.id)]);
  const selected = history.filter(m => chosen.has(m.id));
  const selectedIds = new Set(selected.map(m => m.id));
  const dropped = history.filter(m => !selectedIds.has(m.id));
  return {
    selected, dropped, ranked, query,
    catalog: users.map(({ id, sequence, ref, label }) => ({ id, sequence, ref, label })),
    historyRef: snapshot.ref('/messages'),
    resolve: snapshot.resolve, read: snapshot.read, close: snapshot.close,
    stats: { total: users.length, kept: selected.length + (query ? 1 : 0), dropped: dropped.length, fallback,
      recentKept: recentUsers.length, semanticKept: selected.length - recentUsers.length },
  };
}

