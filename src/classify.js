// Error → ladder class, copied from trained-assist-agent src/opencode-ladder.js (CLASSIFIERS).
// quota = skip the rung for ttlMs; config = never auto-clears; transient = short backoff.

const CLASSIFIERS = [
  { class: 'config', ttlMs: null, pattern: /subscription required/i },
  { class: 'config', ttlMs: null, pattern: /requires global regions/i },
  { class: 'config', ttlMs: null, pattern: /insufficient account funds/i },
  // OpenRouter: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" —
  // баланса 0, каждый вызов на платный ранг уходит в 402. Случай живой с 2026-10-04 (замерено:
  // 2833 отказа 402 в трассе). Деньги кладёт оператор, поэтому это НЕ transient: без своего TTL
  // ранг повторно пытается каждые ~2 с (2 → 4 → 8 … сек) и каждый вызов платит за два мёртвых
  // хопа до отказа. Час — компромисс: после пополнения кредитов ранг возвращается сам, а за час
  // мёртвый хоп оплачивается дважды вместо тысяч. config-класс здесь НЕ годится: он помечает ранг
  // `skipUntil = null` = «никогда не пробовать», а успеха, который бы это снял, не будет, пока
  // ранг и пропущен (см. src/state.js recordFailure).
  { class: 'quota', ttlMs: 60 * 60 * 1000, pattern: /insufficient credits/i },
  // Model slug retired/never had free-tier access — confirmed live against OpenRouter
  // 2026-09-23: e.g. "This model is unavailable for free. The paid version is available
  // now - use this slug instead: ...". This is 'quota' (not 'config'): unlike "subscription
  // required" or "insufficient funds", which block the WHOLE account/profile and justify
  // stopping the task to alert an operator, a retired slug is specific to that one rung —
  // the other rungs in the ladder work fine, so the task should just skip forward silently
  // rather than dead-stop it. 30-day TTL is "practically permanent" — the exhaustion outlives
  // any single task's retry loop — without wiring a whole new never-clears-but-still-degrades
  // class through the config/quota branch in runner/index.js for a case this rare. Whoever
  // fixes the ladder should still remove the dead rung from the profile JSON and this TTL
  // becomes moot.
  // A Go model gated behind the workspace privacy setting "allow paid endpoints that train on
  // request data" (seen live 2026-09-27 on opencode-go/muse-spark-1.3-contributor, both keys).
  // Only an owner flipping that setting in the OpenCode console fixes it — skip the rung for a day
  // instead of burning three same-model retries on it each time the ladder reaches it.
  { class: 'quota', ttlMs: 24 * 60 * 60 * 1000, pattern: /trains on request data/i },
  { class: 'quota', ttlMs: 30 * 24 * 60 * 60 * 1000, pattern: /unavailable for free/i },
  { class: 'quota', ttlMs: 30 * 24 * 60 * 60 * 1000, pattern: /model not found/i },
  { class: 'quota', ttlMs: 30 * 24 * 60 * 60 * 1000, pattern: /no endpoints found/i },
  // OpenRouter's own words: "inclusionai/ling-3.0-flash-sante:free is temporarily rate-limited
  // upstream. Please retry" — занят апстрим ПРЯМО СЕЙЧАС, а не лимит нашего аккаунта, который
  // сбрасывается по часам. Без этой строки матчилось общее `rate-limit`/`429` ниже и ранг уходил
  // в пропуск на ЧАС. Замерено 2026-10-08: так `ling-3.0-flash-sante:free` — единственный бесплатный
  // ранг в `build` с окном 262K, единственный, куда влезал жирный промпт на 129K токенов — был
  // выключен на час после одного 429 в 12:11:07, и все жирные промпты этого часа кончались
  // `every rung failed`. Ровно та же логика, что у `temporarily overloaded` ниже (5 минут).
  { class: 'quota', ttlMs: 5 * 60 * 1000, pattern: /temporarily rate[_\s-]{0,5}limited/i },
  { class: 'quota', ttlMs: 60 * 60 * 1000, pattern: /rate[_\s-]{0,5}limit/i },
  { class: 'quota', ttlMs: 60 * 60 * 1000, pattern: /\b429\b/ },
  { class: 'quota', ttlMs: 24 * 60 * 60 * 1000, pattern: /usage limit/i },
  { class: 'quota', ttlMs: 24 * 60 * 60 * 1000, pattern: /quota[^.]{0,20}exceeded/i },
  // Provider-side capacity issue, not our account's quota — confirmed live 2026-09-23
  // (nemotron-3-ultra-550b-a55b:free returned "Upstream error from Nvidia: Service
  // temporarily overloaded" on 3/3 consecutive calls). Short TTL: this is about the
  // upstream provider being busy right now, not a limit that resets hourly/daily.
  { class: 'quota', ttlMs: 5 * 60 * 1000, pattern: /temporarily overloaded/i },
  { class: 'quota', ttlMs: 5 * 60 * 1000, pattern: /\b503\b/ },
  // opencode's generic server-side error. Confirmed live 2026-09-24: an invalid/retired model
  // slug on the opencode-go gateway (gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra) returns exactly
  // "Unexpected server error" while the valid sibling (gpt-6-luna) works. Without this pattern
  // the ladder only advanced via forceAdvance on retries; a short TTL degrades a dead rung
  // immediately without permanently poisoning a rung that might just be having a transient 5xx.
  { class: 'quota', ttlMs: 5 * 60 * 1000, pattern: /unexpected server error/i },
  // A malformed/rejected model request from the gateway, e.g. `Bad Request: {"model":"deepseek-v4.1-flash"}`
  // (observed live 2026-09-25 on the opencode-go deepseek rung: the same "top" model intermittently
  // rejects a request while its siblings serve fine). Intermittent by nature, so this is NOT a
  // reason to skip the rung right away — retrying the same model a few times is the point
  // (owner 2026-09-26: "частенько багует. нужны ретраи грамотные, альтернатива — если три ретрая
  // не сработали"). Classed 'transient': recordFailure() does NOT mark the rung exhausted and the
  // runner leaves it for the generic same-model retry path; only after the retry budget is spent
  // does forceAdvance() move the task to the sibling rung. Kept LAST of the pre-'context' rules so
  // a more specific signal (429 / usage limit / context) wins when both appear in one error string.
  { class: 'transient', ttlMs: 0, pattern: /bad\s*request/i },
  // The request itself didn't fit this rung's context window — not a quota/config problem
  // with the rung, so unlike the classes above this must NOT persist a shared exhaustion:
  // the next task on this rung (from any user) is very likely a normal-sized prompt that
  // would work fine. recordFailure() below special-cases this class to skip markExhausted
  // entirely; the caller instead skips this one rung for THIS task's own retry only.
  { class: 'context', ttlMs: null, pattern: /context[_\s-]?length/i },
  { class: 'context', ttlMs: null, pattern: /maximum context/i },
  { class: 'context', ttlMs: null, pattern: /context window/i },
  { class: 'context', ttlMs: null, pattern: /prompt is too long/i },
  { class: 'context', ttlMs: null, pattern: /input (?:is )?too long/i },
  { class: 'context', ttlMs: null, pattern: /too many tokens/i },
];

function classifyError(text) {
  const hit = CLASSIFIERS.find(c => c.pattern.test(text || ''));
  return hit ? { class: hit.class, ttlMs: hit.ttlMs } : null;
}

export { CLASSIFIERS, classifyError };
