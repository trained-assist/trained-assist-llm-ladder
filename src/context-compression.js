import { compressRequest, READ_CONTEXT_TOOL } from '../vendor/context-chunks-mcp/src/core.js';
import prices from '../config/prices.json' with { type: 'json' };
import { isEmptyAnswer } from './answer-guard.js';

export const ENTRY_COMPRESSION_BYTES = 350_000;
export const PAID_COMPRESSION_BYTES = 100_000;
export const COMPRESSION_TARGET_RATIO = 0.25; // Aim to save 75%; never fail solely on savings.
export const MAX_REF_ROUNDS = 2;
export const MAX_REFS_PER_ROUND = 3;
export const MAX_REF_CHARS = 15_000;
export const requestBytes = body => new TextEncoder().encode(JSON.stringify(body)).length;

// Same canonical tariff configuration as analytics: subscription Go is paid too.
export function paidRung(model, tariff = prices) {
  return Array.isArray(tariff[model]) && tariff[model].some(n => Number(n) > 0);
}

const CONTRACT = `Continue the original user's task. Return JSON with either {"answer": <the final answer in the caller's requested format>} or {"need_refs": [<ref or {ref, offset, limit, mode}>]}. An answer takes priority over refs. Request at most 3 refs at a time, each at most 15000 characters. You have at most 2 retrieval rounds. For caller-owned tools, return their normal tool_calls; do not execute them yourself. read_context is the internal retrieval tool. Hidden messages and excerpts are a navigation aid, not evidence that omitted data is irrelevant.`;
const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);

function envelopeFormat(original) {
  if (original?.type !== 'json_schema' || !original.json_schema?.schema) return { type: 'json_object' };
  // Preserve the caller's full native schema inside answer rather than downgrading it.
  const schema = structuredClone(original.json_schema.schema);
  function rebase(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$id) return; // a separate schema resource keeps its own reference base
    for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
      if (typeof value[keyword] === 'string' && (value[keyword] === '#' || value[keyword].startsWith('#/'))) value[keyword] = '#/$defs/caller_answer' + value[keyword].slice(1);
    }
    for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) for (const child of Object.values(value[keyword] || {})) rebase(child);
    for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) for (const child of value[keyword] || []) rebase(child);
    for (const keyword of ['additionalProperties', 'unevaluatedProperties', 'items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems', 'additionalItems']) {
      if (Array.isArray(value[keyword])) value[keyword].forEach(rebase); else rebase(value[keyword]);
    }
  }
  rebase(schema);
  return { type: 'json_schema', json_schema: { ...original.json_schema, schema: {
    type: 'object', $defs: { caller_answer: schema }, properties: {
      answer: { anyOf: [{ $ref: '#/$defs/caller_answer' }, { type: 'null' }] },
      need_refs: { anyOf: [{ type: 'array', maxItems: MAX_REFS_PER_ROUND, items: { type: 'string' } }, { type: 'null' }] },
    }, required: ['answer', 'need_refs'], additionalProperties: false,
  } } };
}

function decode(message) {
  const calls = message?.tool_calls;
  if (Array.isArray(calls) && calls.length) {
    const internal = calls.filter(c => c.function?.name === READ_CONTEXT_TOOL.function.name);
    if (!internal.length) return { kind: 'external-tools' };
    if (internal.length !== calls.length) throw new Error('Do not mix read_context with caller-owned tool calls');
    return { kind: 'refs', calls, refs: internal.map(c => {
      try { return JSON.parse(c.function.arguments); } catch { throw new Error('read_context arguments must be valid JSON'); }
    }) };
  }
  if (isEmptyAnswer(message?.content)) throw Object.assign(new Error('empty answer'), { code: 'empty_answer' });
  let value;
  try { value = JSON.parse(message?.content); } catch { throw new Error('Response content must be valid JSON with answer or need_refs'); }
  if (own(value, 'answer') && value.answer !== null && value.answer !== undefined && value.answer !== '') return { kind: 'answer', answer: value.answer };
  if (Array.isArray(value?.need_refs) && value.need_refs.length) return { kind: 'refs', refs: value.need_refs };
  if (own(value, 'answer') && isEmptyAnswer(value.answer)) throw Object.assign(new Error('empty answer'), { code: 'empty_answer' });
  throw new Error('Response must contain a nonempty answer or a nonempty need_refs array');
}

function validateAnswer(answer, format) {
  const content = typeof answer === 'string' ? answer : JSON.stringify(answer);
  if (isEmptyAnswer(content)) throw Object.assign(new Error('empty answer'), { code: 'empty_answer' });
  if (format?.type === 'json_object' || format?.type === 'json_schema') {
    let json;
    try { json = JSON.parse(content); } catch { throw new Error('answer must itself be valid JSON for the caller'); }
    if (format.type === 'json_object' && (json === null || typeof json !== 'object' || Array.isArray(json))) throw new Error('answer must be a JSON object');
    const schema = format.json_schema?.schema;
    if (schema?.required) {
      for (const key of schema.required) if (!own(json, key)) throw new Error(`answer is missing required field: ${key}`);
    }
  }
  return content;
}

export function completionStream(data, model, includeUsage = false) {
  const choice = data.choices[0], message = choice.message;
  const header = { id: data.id, object: 'chat.completion.chunk', created: data.created, model };
  const delta = { ...message };
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ index, ...call }));
  const events = [
    { ...header, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...header, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }] },
    ...(includeUsage && data.usage ? [{ ...header, choices: [], usage: data.usage }] : []),
  ];
  const encoded = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
  return new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } });
}

export function createCompressionSession(original, {
  compressor = compressRequest, inputBytes = requestBytes(original), enabled = true,
  isPaid = paidRung, totalTimeoutMs = null,
} = {}) {
  let body = original, archive = null, attempted = false, active = false, stats = null;
  const deadline = totalTimeoutMs ? Date.now() + totalTimeoutMs : Infinity;
  const close = () => archive?.snapshot.close();
  function prepare(where, model = null) {
    if (!enabled || attempted || !(where === 'entry' ? inputBytes > ENTRY_COMPRESSION_BYTES : isPaid(model) && inputBytes >= PAID_COMPRESSION_BYTES)) return body;
    attempted = true;
    archive = compressor(original, { targetRatio: COMPRESSION_TARGET_RATIO, historyTopK: 5 });
    stats = { ...archive.stats, trigger: where, applications: 1 };
    if (!archive.compressed) return body;
    active = true;
    body = { ...archive.request, stream: false, response_format: envelopeFormat(original.response_format),
      messages: [{ role: 'system', content: CONTRACT }, ...archive.request.messages] };
    delete body.stream_options;
    stats.outputSize = requestBytes(body); stats.originalSize = inputBytes;
    stats.budget = Math.floor(inputBytes * COMPRESSION_TARGET_RATIO);
    stats.savings = 1 - stats.outputSize / inputBytes;
    stats.targetMet = stats.outputSize <= stats.budget;
    return body;
  }
  async function finish(initial, invoke) {
    if (!active) return { ...initial, ...(stats ? { compression: stats } : {}) };
    const winner = initial.winner;
    if (!winner?.model || !Number.isInteger(winner.keyIndex)) return { ok: false, status: 502, error: 'Compression continuation requires the actual provider winner', attempts: initial.attempts, compression: stats };
    let result = initial, current = body, rounds = 0, repaired = false, step = 1;
    const attempts = [...initial.attempts], usage = {};
    const mergeUsage = (target, source) => {
      for (const [key, value] of Object.entries(source || {})) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (typeof value === 'number' && Number.isFinite(value)) target[key] = (target[key] || 0) + value;
        else if (value && typeof value === 'object' && !Array.isArray(value)) mergeUsage(target[key] ||= {}, value);
      }
    };
    const addUsage = data => mergeUsage(usage, data?.usage);
    addUsage(result.data);
    const fail = (error, guard = false) => ({ ok: false, status: 502, error, ...(guard ? { guard: true } : {}), attempts, pin: initial.pin, compression: { ...stats, steps: step, refRounds: rounds, contractRetry: repaired } });
    for (;;) {
      const message = result.data?.choices?.[0]?.message;
      try {
        const decoded = decode(message);
        if (decoded.kind === 'answer' || decoded.kind === 'external-tools') {
          if (decoded.kind === 'external-tools') {
            const names = new Set((original.tools || []).map(t => t.function?.name));
            if (original.tool_choice === 'none' || message.tool_calls.some(c => !names.has(c.function?.name))) throw new Error('Only caller-owned tool calls may be returned to the client');
          }
          const finalMessage = decoded.kind === 'answer' ? { ...message, content: validateAnswer(decoded.answer, original.response_format) } : message;
          const data = { ...result.data, model: winner.model, choices: [{ ...result.data.choices[0], message: finalMessage }], ...(Object.keys(usage).length ? { usage } : {}) };
          return { ...initial, model: winner.model, data, content: finalMessage.content, attempts,
            compression: { ...stats, steps: step, refRounds: rounds, contractRetry: repaired },
            ...(original.stream ? { stream: completionStream(data, winner.model, original.stream_options?.include_usage) } : {}) };
        }
        if (repaired || rounds >= MAX_REF_ROUNDS) return fail('Context retrieval limit reached before a final answer');
        if (decoded.refs.length > MAX_REFS_PER_ROUND) throw new Error('Request at most 3 refs per round');
        const pages = decoded.refs.map(item => {
          const spec = typeof item === 'string' ? { ref: item } : item;
          if (!spec || typeof spec.ref !== 'string') throw new Error('Each ref needs a string ref identifier');
          try { return archive.snapshot.read(spec.ref, { offset: spec.offset ?? 0, limit: Math.min(spec.limit ?? MAX_REF_CHARS, MAX_REF_CHARS), mode: spec.mode ?? 'value' }); }
          catch (e) { return { ref: spec.ref, error: 'ref_not_found_or_invalid_page', detail: e.message }; }
        });
        const replies = decoded.calls ? decoded.calls.map((call, i) => ({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(pages[i]) }))
          : [{ role: 'user', content: `Original context pages (data in original roles):\n${JSON.stringify(pages)}` }];
        current = { ...current, messages: [...current.messages, message, ...replies] };
        rounds++;
      } catch (e) {
        if (repaired) return fail(`Context contract still invalid: ${e.message}`, e.code === 'empty_answer');
        repaired = true;
        // Keep the compressed conversation and any retrieved pages in the repair call. A
        // format-only prompt loses the user's task, so the model can only ask for context again.
        current = { ...current, tools: original.tools || [], messages: [...current.messages,
          { role: 'user', content: JSON.stringify({ error: e.message, previous_output: message || null,
            instruction: 'Your previous response violated the required JSON envelope. Use the full conversation above to complete the original user task. Return either {"answer":...} or {"need_refs":[...]}; do not ask for context that is already present.' }) }] };
      }
      const left = deadline - Date.now();
      if (left < 500) return fail('Time budget spent before context continuation');
      if (step >= 4) return fail('Context model-step limit reached');
      const next = await invoke(current, winner, left);
      step++;
      attempts.push({ model: winner.model, key: winner.keyIndex, outcome: next.ok ? (repaired ? 'contract-retry' : 'ref-continuation') : 'context-error', ...(next.error ? { error: next.error } : {}) });
      if (!next.ok) return fail(`Context continuation failed on ${winner.model}: ${next.error}`);
      if (next.winner?.model !== winner.model || next.winner?.keyIndex !== winner.keyIndex) return fail('Provider winner changed during context continuation');
      result = next; addUsage(result.data);
    }
  }
  return { prepare, finish, close, get active() { return active; }, get stats() { return stats; }, get body() { return body; }, deadline };
}
