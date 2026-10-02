// Trace plumbing: caller-supplied ids (x-ladder-*) → one D1 row per /v1/chat/completions call.
// Kept in its own module so tests can import it without dragging in config/ladders.json.

// Caller-supplied ids that let us attribute a ladder call to a task/session/user later.
// All optional and length-capped; a missing/blank header → null (callers that send none,
// e.g. the bench or one-shot service calls, are still logged with null ids).
export function makeTrace(request) {
  const h = request.headers;
  const get = (key) => {
    const v = h.get(key);
    if (!v) return null;
    const s = String(v).trim();
    return s ? s.slice(0, 200) : null;
  };
  return {
    traceId: get('x-ladder-trace'),
    runId: get('x-ladder-run'),
    userId: get('x-ladder-user'),
    chatId: get('x-ladder-chat'),
    sessionId: get('x-ladder-session'),
  };
}

const TRACE_SQL = `INSERT INTO ladder_calls
  (ts, trace_id, run_id, user_id, chat_id, session_id, ladder, ok, model, ms, attempts, tokens_in, tokens_out, tokens_cached)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`;

// Best-effort D1 append: never fails the call, never throws. Non-stream responses carry
// usage.prompt_tokens/completion_tokens → stored for "how many tokens did this call burn".
// tokens_cached (#94) = usage.prompt_tokens_details.cached_tokens — a subset of tokens_in,
// priced ~50x cheaper, so cost = (in-cached)*in_price + out*out_price + cached*cache_price.
export async function logCall(env, trace, ladder, r, started) {
  const db = env.LADDER_TRACE_DB;
  if (!db) return;
  const usage = !r.stream && r.data && r.data.usage ? r.data.usage : null;
  const cached = usage && usage.prompt_tokens_details ? usage.prompt_tokens_details.cached_tokens : null;
  try {
    await db.prepare(TRACE_SQL).bind(
      Date.now(),
      trace.traceId, trace.runId, trace.userId, trace.chatId, trace.sessionId,
      ladder, r.ok ? 1 : 0, r.model || null, Date.now() - started,
      JSON.stringify(r.attempts || []),
      usage ? usage.prompt_tokens ?? null : null,
      usage ? usage.completion_tokens ?? null : null,
      cached ?? null,
    ).run();
  } catch (e) {
    console.error('trace d1 insert failed:', e.message);
  }
}