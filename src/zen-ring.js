// Zen Ring — a long-lived GitHub Actions job that behaves like an API.
//
// Why this exists: a GitHub-hosted runner has no inbound address (measured — nothing is handed
// back at dispatch time), so "one dispatch per answer" pays a full cold start (~10-13 s measured)
// for every single call. Here ONE job boots, registers itself, and then holds a long-poll open.
// The caller POSTs a task and gets the answer back inside the same HTTP request: no new job, no
// new boot, no log scraping.
//
// The watchdog is the CALLER's, not ours: `wait_ms` says how long the caller is willing to wait
// for an answer. Default 30 s (the owner's number), clamped to [1 s, 90 s] — the ceiling is the
// edge's idle timeout, anything longer must be picked up with GET /zen/pool/result/{id}.
//
// Dependency-free of the Workerd runtime (same rule as handler.js) so `node --test` runs it.

import { applyReport, budgetVerdict, LIMITS, readModel, writeModel, bumpCount, readCounts, sharedDayCap, authorized, resolveToken, pickNextRepo, STALE_TASK_MS, reapStaleTasks, zenSweep } from './zen-runner.js';

export const DEFAULT_WAIT_MS = 30_000;   // the owner's default watchdog
export const MIN_WAIT_MS = 1_000;
export const MAX_WAIT_MS = 90_000;      // under the edge's idle timeout; longer = poll the result
export const DEFAULT_PULL_HOLD_MS = 20_000;  // how long one pull stays open before it re-polls
export const MIN_PULL_HOLD_MS = 5_000;
export const MAX_PULL_HOLD_MS = 25_000;
export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;  // a job with no work for this long exits itself
export const LEASE_TTL_MS = 90_000;     // a job that stops pulling is dead after this
export const ORPHAN_TASK_MS = 120_000;  // a claimed task with no answer for this long is requeued

// Above this input the free tier answers 200 with an EMPTY body instead of a refusal, so the call
// fails anyway — only after 7–12 s of zen time, a task row, a budget bump and a wasted watchdog.
// Measured 2026-10-07 over 2497 tasks, success by input size: 64 % (<5 KB), 68 % (5–20 KB),
// 48 % (20–50 KB), then a cliff — 20 % (50–100 KB), 9 % (100–300 KB), 16–19 % (bigger).
// 50 KB is where the cliff starts; overridable per environment.
export const ZEN_MAX_INPUT_BYTES = 50_000;

// One number for every model is wrong, though: they do NOT hold the same size. Measured
// 2026-10-08 over 5394 tasks (bytes of the JSON messages, success = state 'done'):
//
//   модель                      <20 KB      20–50 KB       >=50 KB
//   nemotron-3-ultra-free        56 %   →    62 % (661/1072)   11 % (27/245)
//   mimo-v2.6-flash-free         63 %   →    18 % ( 33/186)    21 % (73/347)
//
// So nemotron keeps serving through the 20–50 KB band while mimo has already collapsed there —
// refusing mimo at 20 KB costs nothing and saves a hop that would fail 4 times out of 5. The
// global 50 KB stays for everything else, including the band where BOTH models fall apart
// (11 % / 21 %), which is where the original cliff came from.
export const ZEN_MODEL_MAX_INPUT_BYTES = {
  'mimo-v2.6-flash-free': 20_000,
};

// Полоса, в которой гоним несколько моделей СРАЗУ, а не отказываем.
//
// Замер 2026-10-08 (5394 задачи): в полосе 50 КБ+ одиночный вызов выигрывает в 9–20 % случаев.
// Четыре параллельных — 1 − (1−p)^4 ≈ 50–60 %, а это нормально для ЖИРНОГО промпта, у которого
// и так нет дешёвой альтернативы: сегодня такие вызовы получают 413 и уходят по лестнице в
// никуда. Четыре задачи из бесплатного бюджета — меньшая цена, чем `every rung failed`.
//
// Выше жёсткого потолка отказываем как раньше: там даже гонка не спасает (замер: 100–300 КБ —
// 9 % на модель), а бюджет кольца — 500 задач в сутки на (репозиторий, модель).
export const ZEN_RACE_MAX_INPUT_BYTES = 1_000_000;
export const ZEN_RACE_MODELS = Object.freeze([
  'nemotron-3-ultra-free',
  'mimo-v2.6-flash-free',
  'big-pickle',
  'nemotron-3.5-lightning-free',
  // Два новичка без своих замеров в жирной полосе — их и добавляем ради разнообразия: отказы
  // скоррелированы по ВХОДУ, но модели всё-таки расходятся (батч 628 619 байт: lightning упал,
  // три ответили). Копим данные по ним через `raced` в ответе кольца.
  'longcat-2.5-preview-free',
  'ling-3.1-flash-free',
]);
export const ZEN_RACE_MAX = 6;

// Окна контекстов моделей кольца — В ТОКЕНАХ, и только те, что подтверждены ЗАМЕРОМ в проде.
//
// zen не публикует контексты: ни каталог /zen/v1/models (там только id/created/owned_by), ни
// docs/zen (таблица Model | Model ID | Endpoint | SDK), ни инвентарь (context = NULL у всех
// opencode-zen/*). Поэтому карта ниже — это не справочник, а НИЖНИЕ ГРАНИЦЫ: модели отвечали
// на входах ~1 МБ (≈250K токенов по bytes/4) в батчах гонки, значит окно не меньше этого.
//
// Зачем фильтр вообще нужен: в гонку попадает модель, окно которой не вмещает вход, — она
// гарантированно отдаст пусто и просто сожжёт одну из 500 суточных задач. Заполнить карту
// можно и через env: ZEN_MODEL_CONTEXTS='{"exo-free":131072}'.
export const ZEN_MODEL_CONTEXTS = Object.freeze({
  'nemotron-3-ultra-free': 250_000,
  'mimo-v2.6-flash-free': 250_000,
  'big-pickle': 250_000,
  'nemotron-3.5-lightning-free': 250_000,
  // longcat-2.5-preview-free и ling-3.1-flash-free в карте НЕТ: окна неизвестны, поэтому их
  // не отбрасываем — неизвестность не должна выкидывать модель из гонки.
});

// Окно модели в токенах или null (неизвестно / не подтверждено замером).
export function zenContextOf(env, model) {
  const raw = String(env.ZEN_MODEL_CONTEXTS || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const v = Number(parsed?.[model]);
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* битый env не должен ронять вызов — молча берём карту по умолчанию */ }
  }
  const v = Number(ZEN_MODEL_CONTEXTS[model]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Какие модели гоним в деградированной полосе: запрошенная — первой, остальные — из списка
// (env ZEN_RACE_MODELS переопределяет, ZEN_RACE_MAX режет). MODEL_RE отфильтровывает мусор.
export function raceModelsFor(env, requested, inputTokens = null) {
  const raw = String(env.ZEN_RACE_MODELS || '').split(/[\s,]+/).filter(Boolean);
  const list = (raw.length ? raw : ZEN_RACE_MODELS).filter((m) => MODEL_RE.test(m));
  const max = Math.min(Math.max(Number(env.ZEN_RACE_MAX) || ZEN_RACE_MAX, 2), ZEN_RACE_MAX);
  // Модель с подтверждённым окном НИЖЕ входа в гонку не идёт: она гарантированно отдаст пусто
  // и сожжёт задачу бюджета. Неизвестное окно (нет в карте) — не приговор, такую оставляем.
  const fits = (m) => {
    if (inputTokens == null) return true;
    const ctx = zenContextOf(env, m);
    return ctx === null || inputTokens <= ctx;
  };
  return [requested, ...list.filter((m) => m !== requested)].filter(fits).slice(0, max);
}

// ---- ring ceiling + autoscaling (owner's numbers, rationale in docs/zen-runner.md) -----------
// The account allows 20 simultaneous Actions jobs, so the pool can never exceed that — and two
// of the 20 stay free so an ordinary push/PR CI run is never starved by our own workers.
export const RING_CEILING = 20;
export const RING_RESERVE = 2;
// The TTL is the whole point of the pool: one boot (~10-13 s measured) amortised over hours.
// 167 min is the computed TTL for N≈16 workers at λ≈45/min (T = D·N/λ), safely inside the 6 h
// job ceiling. A worker still exits earlier on idle_exit_ms; this is the dispatched default.
export const RING_TTL_MS = 167 * 60_000;
// λ is measured from the task table over a rolling window: every enqueue is one arrival.
export const LAMBDA_WINDOW_MS = 5 * 60_000;
// A dispatched worker needs ~10-13 s to boot and register; until it does, it must count as
// "in flight" or every look at the queue would dispatch a second worker for the same task.
export const BOOT_MS = 25_000;
// Queue depth allowed per live worker before invoke() refuses at the door (#138). See ringInvoke:
// the daily cap is small enough that a saturated queue is what actually spends it.
export const BACKLOG_FACTOR = 2;
// How long one task occupies a worker (measured 2.7-9.5 s end to end; 10 s is the planning
// number). Little's law: N = λ·τ — this is what the scale decision is built on.
export const SERVICE_MS_DEFAULT = 10_000;
const DISPATCH_TIMEOUT_MS = 10_000;
const POLL_STEP_MS = 200;               // first look at the task row after a dispatch
// A 30 s wait is ~50 looks, not ~150: the step grows because the answer itself takes seconds
// (TTFT measured 0.4-3.4 s), and every loop iteration costs CPU against the Worker's CPU limit.
const backoffMs = (i) => Math.min(Math.round(POLL_STEP_MS * 1.6 ** i), 1000);
const BODY_MAX_BYTES = 8 * 1024;
const MODEL_RE = /^[A-Za-z0-9._:@/-]{1,120}$/;

// 204/304 must carry a null body — `new Response('', {status:204})` throws in undici.
const j = (status, obj, headers = {}) =>
  status === 204 || status === 304
    ? new Response(null, { status, headers })
    : new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = (env) => Number(env.ZEN_NOW_MS) || Date.now();

// ---------------------------------------------------------------- pure logic (unit-tested)

export function clampWaitMs(value, { def = DEFAULT_WAIT_MS, min = MIN_WAIT_MS, max = MAX_WAIT_MS } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function clampPullHoldMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PULL_HOLD_MS;
  return Math.min(Math.max(Math.round(n), MIN_PULL_HOLD_MS), MAX_PULL_HOLD_MS);
}

// What a pull should do next. `task` is the claimed task, if one was available.
export function pullDecision({ leaseValid, stopRequested, idleMs, idleExitMs, task = null }) {
  // stop first: a job that was told to stop must hear THAT, not the vaguer "your lease is gone".
  if (stopRequested) return { action: 'exit', reason: 'stop_requested' };
  if (!leaseValid) return { action: 'exit', reason: 'lease_expired' };
  if (task) return { action: 'task', task };
  if (idleMs >= idleExitMs) return { action: 'exit', reason: 'idle_ttl' };
  return { action: 'wait' };
}

export function leaseExpired(row, now) {
  return !row || now > Number(row.lease_expires_at || 0);
}

// Should this worker give up its lease after a failed call?
//
// The measured reality (2026-10-04, three live runs): the daily quota is ~1000 requests per
// (egress IP, model) and a GitHub Actions run gets a NEW egress IP every time it boots — five
// consecutive runs on this account came up on 13.71.231.39, 128.203.190.81, 172.184.213.225,
// 172.184.211.241, 135.232.201.244. So an address that answered `daily` is not a dead model and
// not a dead provider: it is a spent address, and the cure is a new job, not a retry.
//
// That makes this the one rotation point of the whole pool. A worker that keeps its lease after
// `daily` goes on claiming tasks and failing every one of them — each failure burns a queued task
// and the caller's watchdog — while the address stays dark until 00:00 UTC. Handing the lease back
// is what lets the autoscaler boot a fresh run, which lands on a fresh address with a full quota.
//
// `provider` (a bare 429 with no retry-after) is the same wall seen from the other side: the
// per-minute burst limit, measured at ~90-95/min per (IP, model). Our own governor holds 50/min, so
// hitting it means the address is being shared with something else and is equally spent.
// `rate` is the same shape without the provider marker. `timeout` and `error` are NOT rotation:
// those are transient and the address is still good, so the worker stays and serves the next task.
export function shouldRotateOnResult(kind) {
  return kind === 'daily' || kind === 'provider' || kind === 'rate';
}

// Same question for the LOCAL budget: once a worker has spent its own daily allowance it is out of
// addresses' worth of quota too, so it rotates instead of sitting on a lease it can never use.
export function shouldRotateOnLocalStop(stoppedBy) {
  return stoppedBy === 'local-budget';
}

// A lease is usable only while the job is live AND has not gone silent: a job that died without
// saying goodbye simply stops renewing, and this is what drops it out of the pool.
export function leaseUsable(row, now) {
  return !!row && row.state === 'live' && !leaseExpired(row, now);
}

// ---- autoscaling logic (pure, unit-tested) ---------------------------------------------------

// λ, arrivals per minute, from a raw count over a window. Kept as its own function because the
// window is a knob: the caller's own traffic is bursty and a 5-min mean is what the pool sizes to.
export function lambdaPerMin(count, windowMs = LAMBDA_WINDOW_MS) {
  const n = Number(count) || 0;
  if (!(windowMs > 0)) return 0;
  return (n * 60_000) / windowMs;
}

// Workers already being born but not yet registered: dispatches in the boot window minus workers
// that registered inside it. Floored at 0 so a burst of registrations never goes negative.
export function inflightFrom({ recentDispatches = 0, recentRegistrations = 0 } = {}) {
  return Math.max(0, (Number(recentDispatches) || 0) - (Number(recentRegistrations) || 0));
}

// How many workers SHOULD be live. Two rules, in order:
//   1. Ф8 — a non-empty queue scales up immediately: at least one more worker than there are
//      (this is what makes a cold ring answer a real call instead of returning 503);
//   2. Little's law — N = λ·τ, so a sustained λ is served without queueing.
// The ceiling minus the reserve is a hard cap: the account has 20 job slots and two of them stay
// free for ordinary CI. The reserve is headroom, not a floor — a single cold call boots one worker,
// not three. An empty queue never scales up: idle workers exit on their own TTL.
export function desiredWorkers({
  lambdaPerMin: lambda = 0, serviceMs = SERVICE_MS_DEFAULT, queued = 0, demand = 0,
  live = 0, inflight = 0, ceiling = RING_CEILING, reserve = RING_RESERVE,
} = {}) {
  const cap = Math.max(0, Number(ceiling) - Number(reserve));
  const pending = Math.max(Number(queued) || 0, Number(demand) || 0);
  if (pending <= 0) return Math.min(Number(live) || 0, cap);
  const byLaw = Math.ceil(((Number(lambda) || 0) * (Number(serviceMs) || 0)) / 60_000);
  const want = Math.max(1, (Number(live) || 0) + 1, byLaw);
  return Math.min(want, cap);
}

// The whole decision in one place: how many to boot right now and why. `reason` is what the
// endpoint reports, so an operator never has to guess why nothing was dispatched.
export function scaleDecision({
  lambdaPerMin: lambda = 0, serviceMs = SERVICE_MS_DEFAULT, queued = 0, demand = 0,
  live = 0, inflight = 0, ceiling = RING_CEILING, reserve = RING_RESERVE,
} = {}) {
  const desired = desiredWorkers({ lambdaPerMin: lambda, serviceMs, queued, demand, live, inflight, ceiling, reserve });
  const toDispatch = Math.max(0, desired - (Number(live) || 0) - (Number(inflight) || 0));
  let reason = 'at_target';
  if (toDispatch > 0) reason = Math.max(Number(queued) || 0, Number(demand) || 0) > 0 ? 'queue_not_empty' : 'lambda';
  else if (desired >= Math.max(0, Number(ceiling) - Number(reserve))) reason = 'at_ceiling';
  return { desired, toDispatch, reason, lambdaPerMin: lambda, queued, live, inflight };
}

// ---------------------------------------------------------------- D1 helpers

const db = (env) => env.ZEN_DB;

async function readTask(env, id) {
  return await db(env).prepare('SELECT * FROM zen_pool_tasks WHERE id = ?1').bind(id).first();
}

async function readLiveWorkers(env, now) {
  return (await db(env).prepare(
    'SELECT * FROM zen_pool_workers WHERE state = ?1 AND lease_expires_at > ?2 ORDER BY last_seen_at DESC'
  ).bind('live', now).all()).results || [];
}

// Claim the oldest queued task. The `state='queued'` guard in the UPDATE is what makes two
// pollers racing for the same task safe: exactly one of them sees changes = 1.
async function claimTask(env, workerId, leaseId, now) {
  // FIRST bury the dead. Without this the poll loop recycles them forever: orphan requeue below
  // puts an unanswered row back in `queued`, the next pull claims it, and it never ends — the
  // worker churns, `tasks_served` stays flat, and the rung stays shut (see reapStaleTasks).
  await reapStaleTasks(env, now);
  await db(env).prepare(
    'UPDATE zen_pool_tasks SET state = ?1, worker_id = NULL, lease_id = NULL WHERE state = ?2 AND claimed_at < ?3'
  ).bind('queued', 'claimed', now - ORPHAN_TASK_MS).run();
  const row = await db(env).prepare(
    'SELECT id FROM zen_pool_tasks WHERE state = ?1 ORDER BY enqueued_at LIMIT 1'
  ).bind('queued').first();
  if (!row) return null;
  const res = await db(env).prepare(
    'UPDATE zen_pool_tasks SET state = ?1, worker_id = ?2, lease_id = ?3, claimed_at = ?4 WHERE id = ?5 AND state = ?6'
  ).bind('claimed', workerId, leaseId, now, row.id, 'queued').run();
  if (!res?.meta?.changes) return null;
  return await readTask(env, row.id);
}

async function writeResult(env, task, body, now) {
  await db(env).prepare(
    `UPDATE zen_pool_tasks SET state = ?1, ok = ?2, text = ?3, kind = ?4, error = ?5,
       provider_ms = ?6, served_ms = ?7, finished_at = ?8, tool_calls = ?9, usage = ?10, finish_reason = ?11
     WHERE id = ?12`
  ).bind(
    body.ok ? 'done' : 'failed', body.ok ? 1 : 0,
    body.ok ? String(body.text || '') : null,
    body.ok ? 'ok' : String(body.kind || 'error').slice(0, 40),
    body.ok ? null : String(body.error || '').slice(0, 500),
    Number(body.provider_ms) || null, Number(body.served_ms) || null, now,
    // tool_calls / usage / finish_reason are persisted regardless of `ok`: they are the ONLY
    // evidence of WHY an answer was empty, and today 45 % of tasks fail exactly that way while
    // being written down as four NULLs. `text` stays conditional — for a kind='ok' failure it is
    // empty by definition, so there is nothing to store (#166 keeps the payload small).
    body.tool_calls ? JSON.stringify(body.tool_calls) : null,
    body.usage ? JSON.stringify(body.usage).slice(0, 2000) : null,
    body.finish_reason ? String(body.finish_reason).slice(0, 40) : null,
    task.id,
  ).run();
  await db(env).prepare('UPDATE zen_pool_workers SET tasks_served = tasks_served + 1, last_seen_at = ?1 WHERE id = ?2')
    .bind(now, task.lease_id).run();
}

// ---------------------------------------------------------------- pool metrics + dispatch

const poolCeiling = (env) => Math.max(1, Number(env.ZEN_RING_CEILING) || RING_CEILING);
const poolReserve = (env) => Math.max(0, Number(env.ZEN_RING_RESERVE) || RING_RESERVE);
const poolTtl = (env) => Math.max(60_000, Number(env.ZEN_RING_TTL_MS) || RING_TTL_MS);

// Only tasks a caller can still be waiting for count against the door (see STALE_TASK_MS): a row
// nobody has touched for 10 minutes is not back-pressure, it is litter.
async function readQueued(env) {
  const freshSince = nowMs(env) - STALE_TASK_MS;
  return (await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_tasks WHERE state = ?1 AND enqueued_at >= ?2')
    .bind('queued', freshSince).first())?.n ?? 0;
}

// λ: every row in zen_pool_tasks was one arrival, so a window count is the whole measurement —
// no separate metrics table to drift out of sync with reality.
async function readLambda(env, now, windowMs = LAMBDA_WINDOW_MS) {
  const row = await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_tasks WHERE enqueued_at > ?1')
    .bind(now - windowMs).first();
  return { count: row?.n ?? 0, windowMs, perMin: lambdaPerMin(row?.n ?? 0, windowMs) };
}

async function readInflight(env, now) {
  const since = now - BOOT_MS;
  const dispatched = (await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_dispatches WHERE requested_at > ?1').bind(since).first())?.n ?? 0;
  const registered = (await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_workers WHERE registered_at > ?1').bind(since).first())?.n ?? 0;
  return inflightFrom({ recentDispatches: dispatched, recentRegistrations: registered });
}

// One tick of the worker's own cron: grow the ring if the queue is waiting, then bury the dead
// and re-check quarantined models. This lives HERE, not in a GitHub workflow, because GitHub's
// `*/2` schedule does not deliver */2 — measured 2026-10-07: runs landed 4-7 hours apart, all
// failing (SCALE_CONFIG_MISSING), so the ring was never grown on a schedule at all. The worker's
// own trigger is the only cadence we control.
export async function runMaintenance(env, { fetchImpl = fetch } = {}) {
  const safe = (fn) => Promise.resolve().then(fn).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  const scale = await safe(() => scaleRing(env, { fetchImpl }));
  const sweep = await safe(() => zenSweep(env, fetchImpl));
  const summary = {
    route: 'cron/maintenance',
    dispatched: (scale.dispatched || []).length,
    scale_reason: scale.reason || (scale.ok ? 'at_target' : 'n/a'),
    checked: sweep.checked ?? 0,
    reaped: sweep.reaped ?? 0,
  };
  console.log(JSON.stringify(summary));
  return { scale, sweep, summary };
}

export async function recentDispatches(env, limit = 10) {
  return (await db(env).prepare(
    'SELECT id, repo, reason, requested_at, worker_id, state FROM zen_pool_dispatches ORDER BY requested_at DESC LIMIT ?1'
  ).bind(limit).all()).results || [];
}

async function recordDispatch(env, { id, repo, reason, now }) {
  await db(env).prepare(
    'INSERT INTO zen_pool_dispatches (id, repo, reason, requested_at, state) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(id, repo, reason, now, 'dispatched').run();
}

// One dispatch = one long-lived pool worker in a ring repository. The repo token is the same one
// the cold-dispatch path uses; a repo without a usable token is simply skipped.
async function dispatchPoolWorker(env, repo, row, token, { idleExitMs, runId, now, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: { authorization: `token ${token}`, 'content-type': 'application/json',
      accept: 'application/vnd.github+json', 'user-agent': 'trained-assist-llm-ladder' },
    body: JSON.stringify({ event_type: 'zen-pool', client_payload: {
      run_id: runId, idle_exit_ms: idleExitMs, max_tasks: 0, out: 'zen-rings-last.json',
      requested_at: new Date(now).toISOString(), location: row?.location || '',
    } }),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  return res.status;
}

// The autoscaler. Called from /zen/pool/scale (a scheduled workflow) and from /zen/pool/invoke
// when the pool is cold — the second caller is what makes "scale up the moment a call arrives"
// true rather than "within the next cron tick". Returns what it decided and what it dispatched.
export async function scaleRing(env, { now, demand = 0, fetchImpl = fetch } = {}) {
  const t = now ?? nowMs(env);
  const ceiling = poolCeiling(env), reserve = poolReserve(env), ttl = poolTtl(env);
  if (String(env.ZEN_POOL_AUTOSCALE || '').toLowerCase() === 'off') {
    return { ok: false, reason: 'autoscale_off', dispatched: [], ceiling, reserve, ttl_ms: ttl };
  }
  const live = (await readLiveWorkers(env, t)).length;
  const queued = await readQueued(env);
  const inflight = await readInflight(env, t);
  const lambda = await readLambda(env, t);
  const decision = scaleDecision({
    lambdaPerMin: lambda.perMin, queued, demand, live, inflight, ceiling, reserve,
    serviceMs: Number(env.ZEN_POOL_SERVICE_MS) || SERVICE_MS_DEFAULT,
  });
  const out = { ok: true, ...decision, lambda_count: lambda.count, window_ms: lambda.windowMs,
    ceiling, reserve, ttl_ms: ttl, dispatched: [], errors: [] };
  if (decision.toDispatch <= 0) return out;

  const repos = (await db(env).prepare('SELECT * FROM zen_repos WHERE enabled = 1 ORDER BY added_at, repo').all()).results || [];
  if (!repos.length) {
    out.ok = false; out.reason = 'no_ring_repo';
    out.hint = 'POST /zen/repos {repo, token|token_ref} — the pool can only boot a worker in a registered repo';
    return out;
  }
  const cursorRow = await db(env).prepare("SELECT v FROM zen_meta WHERE k = 'pool_cursor'").first();
  let cursor = Number(cursorRow?.v) || 0;
  const skip = new Set();
  for (let i = 0; i < decision.toDispatch; i++) {
    const pick = pickNextRepo(repos, cursor, skip);
    if (!pick) { out.errors.push({ error: 'no usable ring repository' }); break; }
    cursor = pick.cursor;
    const token = await resolveToken(pick.row, env);
    if (!token) { skip.add(pick.repo); out.errors.push({ repo: pick.repo, error: 'no usable token' }); i--; continue; }
    const id = `${t.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    let status;
    try {
      status = await dispatchPoolWorker(env, pick.repo, pick.row, token, { idleExitMs: ttl, runId: id, now: t, fetchImpl });
    } catch (e) {
      out.errors.push({ repo: pick.repo, error: `dispatch_failed:${e?.name || 'Error'}` });
      continue;
    }
    if (status < 200 || status >= 300) { out.errors.push({ repo: pick.repo, gh_status: status }); continue; }
    await recordDispatch(env, { id, repo: pick.repo, reason: decision.reason, now: t });
    out.dispatched.push({ id, repo: pick.repo, idle_exit_ms: ttl });
  }
  await db(env).prepare('INSERT INTO zen_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind('pool_cursor', String(cursor)).run();
  if (!out.dispatched.length && out.ok) { out.ok = false; out.reason = out.reason === 'at_target' ? 'at_target' : 'dispatch_failed'; }
  return out;
}

// ---------------------------------------------------------------- routes

// POST /zen/pool/register — the job announces itself and gets a lease.
export async function zenRingRegister(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const now = nowMs(env);
  const workerId = String(body.worker_id || '').slice(0, 160);
  if (!workerId) return j(400, { error: 'worker_id is required (repo:run:attempt)' });
  const leaseId = crypto.randomUUID();
  const idleExit = Math.min(Math.max(Number(body.idle_exit_ms) || DEFAULT_IDLE_EXIT_MS, 60_000), 6 * 3_600_000);
  await db(env).prepare(
    `INSERT INTO zen_pool_workers (id, worker_id, repo, run_id, run_attempt, egress_ip, runner_name, node,
       state, tasks_served, idle_exit_ms, lease_expires_at, registered_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'live', 0, ?9, ?10, ?11, ?11)
     ON CONFLICT(id) DO UPDATE SET state='live', tasks_served=0, lease_expires_at=?10, last_seen_at=?11`
  ).bind(leaseId, workerId, String(body.repo || '').slice(0, 120), String(body.run_id || '').slice(0, 80),
    String(body.run_attempt || '').slice(0, 20), String(body.egress_ip || '').slice(0, 64),
    String(body.runner_name || '').slice(0, 120), String(body.node || '').slice(0, 40),
    idleExit, now + LEASE_TTL_MS, now).run();
  const live = await readLiveWorkers(env, now);
  return j(200, {
    lease_id: leaseId,
    lease_expires_in_ms: LEASE_TTL_MS,
    pull_hold_ms: clampPullHoldMs(body.pull_hold_ms),
    idle_exit_ms: idleExit,
    poll_step_ms: POLL_STEP_MS,
    workers_live: live.length,
    worker_ids: live.map((w) => w.worker_id),
  });
}

// GET /zen/pool/pull?lease=… — long-poll. 200 {task} | 200 {bye} | 204 (nothing yet).
export async function zenRingPull(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const url = new URL(request.url);
  const leaseId = String(url.searchParams.get('lease') || '');
  if (!leaseId) return j(400, { error: 'lease is required' });
  const hold = clampPullHoldMs(url.searchParams.get('hold_ms'));
  const now = nowMs(env);
  const row = await db(env).prepare('SELECT * FROM zen_pool_workers WHERE id = ?1').bind(leaseId).first();
  if (leaseExpired(row, now)) {
    return j(200, { bye: true, reason: 'lease_expired', hint: 'register again' });
  }
  const deadline = Date.now() + hold;
  let step = 0;
  for (;;) {
    const t = nowMs(env);
    await db(env).prepare('UPDATE zen_pool_workers SET lease_expires_at = ?1, last_seen_at = ?2 WHERE id = ?3')
      .bind(t + LEASE_TTL_MS, t, leaseId).run();
    const task = await claimTask(env, row.worker_id, leaseId, t);
    const fresh = await db(env).prepare('SELECT * FROM zen_pool_workers WHERE id = ?1').bind(leaseId).first();
    const decision = pullDecision({
      leaseValid: leaseUsable(fresh, t),
      stopRequested: fresh.state !== 'live',
      idleMs: t - Number(fresh.registered_at || t),
      idleExitMs: Number(fresh.idle_exit_ms || DEFAULT_IDLE_EXIT_MS),
      task,
    });
    if (decision.action === 'task') return j(200, { task: taskRow(decision.task) });
    if (decision.action === 'exit') {
      await db(env).prepare('UPDATE zen_pool_workers SET state = ?1, stop_reason = ?2, exited_at = ?3 WHERE id = ?4')
        .bind('gone', decision.reason, t, leaseId).run();
      return j(200, { bye: true, reason: decision.reason });
    }
    if (Date.now() >= deadline) return j(204, {});
    await sleep(backoffMs(step++));
  }
}

// POST /zen/pool/result — the answer, and the only way the quarantine learns anything.
export async function zenRingResult(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const taskId = String(body.task_id || '').slice(0, 80);
  if (!taskId) return j(400, { error: 'task_id is required' });
  const task = await readTask(env, taskId);
  if (!task) return j(404, { error: 'unknown task' });
  if (task.state !== 'claimed') return j(409, { error: `task is ${task.state}, not claimed` });
  const now = nowMs(env);
  await writeResult(env, task, body, now);
  const state = applyReport(await readModel(env, task.model), { ok: !!body.ok, kind: body.kind, error: body.error }, now);
  await writeModel(env, task.model, state);

  // The rotation point. A quota refusal means this run's egress address is spent, and a new run
  // gets a new one — so the worker is told to hand its lease back instead of claiming the next task
  // and failing that too. `bye: true` here is what the worker's pull loop acts on; the autoscaler
  // then sees one fewer live worker and boots a replacement on a fresh address.
  const rotate = shouldRotateOnResult(body.ok ? null : body.kind) || shouldRotateOnLocalStop(body.stopped_by);
  if (rotate) {
    await db(env).prepare(
      "UPDATE zen_pool_workers SET state = ?1, stop_reason = ?2, exited_at = ?3 WHERE id = ?4 AND state = 'live'"
    ).bind('gone', `quota:${String(body.kind || 'unknown').slice(0, 40)}`, now, task.lease_id).run();
  }
  return j(200, {
    accepted: true, task_id: taskId, state: state.status, next_check_in: Math.max(0, state.next_check_at - now),
    rotate, bye: rotate,
    rotate_reason: rotate ? `address spent (${body.kind || 'unknown'}) — start a new run for a fresh one` : null,
  });
}

// POST /zen/pool/stop — "а потом её убиваем": the next pull says bye and the job exits cleanly.
export async function zenRingStop(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body;
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const workerId = String(body.worker_id || '').slice(0, 160);
  if (!workerId) return j(400, { error: 'worker_id is required' });
  const now = nowMs(env);
  const res = await db(env).prepare(
    "UPDATE zen_pool_workers SET state = 'stopping', stop_reason = 'stop_requested' WHERE worker_id = ?1 AND state = 'live'"
  ).bind(workerId).run();
  return j(200, { ok: true, stopped: !!res?.meta?.changes, worker_id: workerId });
}

// POST /zen/pool/invoke {model, prompt, max_tokens?, wait_ms?} — the whole point: one HTTP call,
// one answer, no job per call. 200 {text} | 504 {task_id} (answer still lands, fetch it) |
// 503 (no warm worker) | 409 (quarantine) | 429 (budget).
// The pool's core, free of the HTTP shape so the ladder can call it in-process (same worker, same
// env — no token, no second hop). Returns { status, data } exactly as the route would.
// Ставит задачи на модели гонки и списывает квоту по каждой. Один вызов — одна строка в
// zen_pool_tasks и один bump по (репозиторий, модель) плюс один общий bump провайдера.
async function enqueueTasks(env, { racing, repoScope, prompt, messages, tools, options, maxTokens, waitMs, now }) {
  const ids = [];
  for (const m of racing) {
    const id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    await db(env).prepare(
      `INSERT INTO zen_pool_tasks (id, model, prompt, messages, tools, max_tokens, wait_ms, state, enqueued_at, options)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(id, m, prompt.slice(0, 4000), messages, tools, maxTokens, waitMs, 'queued', now, options).run();
    await bumpCount(env, repoScope, m, now);
    ids.push({ id, model: m });
  }
  await bumpCount(env, '*', '*', now);
  return ids;
}

// Ждёт гонку до первого НЕПУСТОГО ответа, до провала всех задач или до вотчдога.
//
// Побеждает первый непустой: пустое тело — основной вид проигрыша в деградированной полосе
// (замер: 1073 вызова, 100 % пустого текста), поэтому `ok:false` не может выиграть, даже если
// задача формально «выполнена». Если проиграли все — возвращаем причину первой из них, чтобы
// лестница классифицировала отказ, а не получила пустоту.
async function awaitRacedAnswer(env, ids, { waitMs, cold = null }) {
  const raced = ids.map((t) => t.model);
  const deadline = Date.now() + waitMs;
  let step = 0;
  for (;;) {
    const rows = await Promise.all(ids.map((t) => readTask(env, t.id)));
    const win = rows.findIndex((row) => row && row.state === 'done' && (row.ok || !!row.tool_calls));
    if (win >= 0) {
      const row = rows[win];
      const { id, model } = ids[win];
      return {
        status: 200,
        data: {
          task_id: id, model, ok: true, text: row.text || null, kind: row.kind,
          error: row.error, provider_ms: row.provider_ms, served_ms: row.served_ms,
          worker_id: row.worker_id, wait_ms: waitMs, raced,
          ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) } : {}),
          ...(row.usage ? { usage: JSON.parse(row.usage) } : {}),
          ...(row.finish_reason ? { finish_reason: row.finish_reason } : {}),
          ...(cold ? { cold_start: cold } : {}),
        },
      };
    }
    const allTerminal = rows.every((row) => row && (row.state === 'done' || row.state === 'failed'));
    if (allTerminal) {
      const first = rows.find((row) => row && row.state === 'done' && !row.ok) || rows.find((row) => row) || {};
      return {
        status: 502,
        data: {
          task_id: ids[0].id, model: first.model || ids[0].model, ok: false, text: null, kind: first.kind,
          error: first.error || 'empty answer from every raced model',
          raced, provider_ms: first.provider_ms, served_ms: first.served_ms, wait_ms: waitMs,
          ...(first.tool_calls ? { tool_calls: JSON.parse(first.tool_calls) } : {}),
          ...(first.usage ? { usage: JSON.parse(first.usage) } : {}),
          ...(first.finish_reason ? { finish_reason: first.finish_reason } : {}),
        },
      };
    }
    if (Date.now() >= deadline) {
      for (const t of ids) {
        await db(env).prepare('UPDATE zen_pool_tasks SET wait_returned_at = ?1 WHERE id = ?2').bind(nowMs(env), t.id).run();
      }
      return { status: 504, data: { error: 'watchdog fired before the answer arrived', task_id: ids[0].id,
        task_ids: ids.map((t) => t.id), raced, wait_ms: waitMs,
        ...(cold ? { cold_start: cold } : {}),
        hint: 'the job is still working — GET /zen/pool/result/{task_id} picks the answer up' } };
    }
    await sleep(backoffMs(step++));
  }
}

export async function ringInvoke(env, body, fetchImpl = fetch) {
  if (!env.ZEN_DB) return { status: 503, data: { error: 'zen database not configured' } };
  const model = String(body.model || '');
  if (!MODEL_RE.test(model)) return { status: 400, data: { error: 'model is required (explicit id)' } };
  // `messages` is the full OpenAI array (system + history + tools) — what the ladder sends.
  // `prompt` stays as the one-line fallback for the older callers and the CLI.
  let messages = null;
  let tools = null;
  if (Array.isArray(body.messages) && body.messages.length) {
    messages = JSON.stringify(body.messages);
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    tools = JSON.stringify(body.tools);
  }
  if ((messages?.length || 0) > 2_000_000 || (tools?.length || 0) > 500_000) return { status: 413, data: { error: 'input is too long for the ring payload' } };
  const options = body.response_format !== undefined || body.tool_choice !== undefined
    ? JSON.stringify({ response_format: body.response_format, tool_choice: body.tool_choice }) : null;
  const prompt = String(body.prompt ?? '');
  if (!messages && !prompt.trim()) return { status: 400, data: { error: 'prompt is required' } };

  // Refuse fat inputs at the door. zen does not refuse them — it returns 200 with an empty body
  // (1073 such calls measured, 100 % empty text), which the ladder counts as a failed rung anyway.
  // So sending this costs the caller 7–12 s of watchdog plus a task row and a budget bump, and
  // buys nothing: above 50 KB success is 9–20 %, below it 48–68 %.
  //
  // The wording is not decoration: `input is too long` is what `classify.js` matches as `context`
  // — a class that exists precisely because a normal-sized prompt from the NEXT caller still
  // deserves this rung. Note `failureClass()` in src/ladder.js collapses everything except quota
  // and config to `transient`, so this lands exactly where a today's empty-body answer lands, only
  // without the wait.
  const inputBytes = new TextEncoder().encode((messages || '') + (tools || '') + (options || '')).length;
  // Order matters: an explicit env override wins (an operator forcing a global number),
  // then this model's own measured ceiling, then the shared default.
  const inputLimit = Number(env.ZEN_MAX_INPUT_BYTES)
    || ZEN_MODEL_MAX_INPUT_BYTES[model]
    || ZEN_MAX_INPUT_BYTES;
  // Деградированная полоса: вместо отказа гоним несколько моделей сразу (см. ZEN_RACE_*).
  // Отказ остаётся только там, где и гонка не спасает — выше жёсткого потолка.
  const raceCap = Number(env.ZEN_RACE_MAX_INPUT_BYTES) || ZEN_RACE_MAX_INPUT_BYTES;
  const exact = body.exact_model === true;
  const exactFits = exact && inputBytes <= raceCap && (zenContextOf(env, model) === null || Math.ceil(inputBytes / 4) <= zenContextOf(env, model));
  const race = !exact && inputBytes > inputLimit && inputBytes <= raceCap
    ? raceModelsFor(env, model, Math.ceil(inputBytes / 4)) : [];
  if (!race.length && inputBytes > inputLimit && !exactFits) {
    return {
      status: 413,
      data: {
        error: `input is too long for the free tier: ${inputBytes} bytes, limit ${inputLimit}`,
        bytes: inputBytes, limit: inputLimit,
        hint: 'the caller walks to the next rung at once — nothing was queued, no quota spent',
      },
    };
  }
  const waitMs = clampWaitMs(body.wait_ms);
  // The clamp is a ceiling, not a floor: an agent turn can need a long answer (a file edit), and
  // the ladder already clamps max_tokens to what the model takes.
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 300, 1), 32_768);
  const now = nowMs(env);

  // Deliberately NO quarantine check here. The quarantine table answers "should we go and PROBE this
  // model on a schedule" — it exists so the self-test stops poking a dead provider 100 times. It
  // must not answer "a caller named this model explicitly and wants an answer": that is the whole
  // point of the pool, and the budget below is the real protection. The result is still recorded
  // (applyReport below), so an explicit call is also the cheapest possible re-check.
  const workers = await readLiveWorkers(env, now);
  // Cold pool: instead of a bare 503, boot a worker now and let the caller's own watchdog cover the
  // ~10-13 s boot — the task is enqueued below and the worker claims it on its first pull. Only
  // when there is nothing to boot with (autoscale off, no ring repo, ceiling reached) is the 503
  // still the honest answer.
  let coldStart = null;
  if (!workers.length) {
    coldStart = await scaleRing(env, { now, demand: 1, fetchImpl });
    if (!coldStart.dispatched.length) {
      return { status: 503, data: { error: 'no warm runner', scaled: coldStart.reason, ceiling: coldStart.ceiling,
        reserve: coldStart.reserve, hint: coldStart.hint || 'dispatch zen-rings.yml in a ring repository, or use POST /zen/run for a cold dispatch' } };
    }
  }
  const repoScope = workers[0]?.repo || coldStart?.dispatched?.[0]?.repo || '*';
  const perMin = Number(env.ZEN_PER_MIN) || LIMITS.perMin;
  const perDay = Number(env.ZEN_PER_DAY) || LIMITS.perDay;
  // #133: общий дневной потолок провайдера — один на все модели, поэтому проверяется один раз.
  const perAll = budgetVerdict(await readCounts(env, '*', '*'), now,
    { perMin, perDay: await sharedDayCap(env, perDay, now) });
  if (!perAll.ok) {
    return { status: 429, data: { error: `budget exhausted (${perAll.reason})`, reason: perAll.reason, retry_after: perAll.retry_after } };
  }

  // Одна модель (обычный путь) или гонка: budgetVerdict считает по (репозиторий, модель), так
  // что исчерпанный лимит одной модели не должен ронять всю гонку — её просто делают уже.
  const wanted = race.length ? race : [model];
  const eligible = [];
  const refused = [];
  for (const m of wanted) {
    const v = budgetVerdict(await readCounts(env, repoScope, m), now, { perMin, perDay });
    if (v.ok) eligible.push(m); else refused.push({ model: m, reason: v.reason, retry_after: v.retry_after });
  }
  if (!eligible.length) {
    const first = refused[0] || { reason: 'budget', retry_after: 0 };
    return { status: 429, data: { error: `budget exhausted (${first.reason})`, reason: first.reason, retry_after: first.retry_after, models: refused } };
  }

  // #138, the load-bearing half. The daily cap is 500 requests per (repo, model) AND provider-wide
  // — one of the scarcest resources here. Queue depth is what turns that cap into a loss: every task
  // admitted while the pool is saturated is served by a worker and burns quota on an answer whose
  // caller already failed over. So refuse AT THE DOOR, before the task exists: no row, no budget
  // bump, nothing to serve, nothing wasted.
  const live = workers.length;
  const cap = Math.max(BACKLOG_FACTOR * live, 1);
  const queued = await readQueued(env);
  // Гонка влезает ЦЕЛИКОМ в свободные слоты, а не роняет вызов: на маленьком кольце
  // (live = 1 → cap = 2) гонка из четырёх превращается в две или в одиночный вызов —
  // это лучше отказа, а кольцо тем временем подрастает (scaleRing ниже).
  const slots = Math.max(0, cap - queued);
  if (slots === 0) {
    // A full queue under ONE worker is a capacity problem, not a health problem — so grow the ring
    // while refusing. scaleRing is idempotent inside BOOT_MS (25 s).
    await scaleRing(env, { now, demand: queued + eligible.length, fetchImpl });
    return {
      status: 503,
      data: {
        error: 'pool_backlog', queued, live, cap, wanted: eligible.length,
        hint: 'pool is saturated — the task was NOT queued, no quota spent',
      },
    };
  }
  const racing = eligible.slice(0, slots);

  const ids = await enqueueTasks(env, { racing, repoScope, prompt, messages, tools, options, maxTokens, waitMs, now });
  const cold = coldStart ? { scaled: coldStart.reason, dispatched: coldStart.dispatched.map((d) => d.repo), boot_ms: BOOT_MS } : null;
  return awaitRacedAnswer(env, ids, { waitMs, cold });
}

// How long to leave the pool alone after a cold start. A freshly booted runner is still
// settling (first calls are slower), so a call that lands right after the boot is skipped — the
// ladder walks down instead, and the pool is left to warm up undisturbed.
export const WARMUP_COOLDOWN_MS = 60_000;

// Milliseconds of cooldown left after the last cold start (0 = the pool may be used now).
export async function ringCooldown(env, { windowMs = WARMUP_COOLDOWN_MS } = {}) {
  const row = await db(env).prepare("SELECT v FROM zen_meta WHERE k = ?1").bind('last_boot_at').first();
  const at = Number(row?.v) || 0;
  if (!at) return 0;
  return Math.max(0, windowMs - (nowMs(env) - at));
}

// Boot a ring worker WITHOUT enqueuing a task — the "cold start" answer. The caller fails over
// now instead of burning its whole rung budget on a one-time ~10-13 s boot, and the pool is warm
// for the next call. Idempotent in effect: a worker already booting counts as in-flight, so a
// second cold call inside the boot window dispatches nothing.
export async function ringBoot(env, { fetchImpl = fetch } = {}) {
  const now = nowMs(env);
  const live = (await readLiveWorkers(env, now)).length;
  if (live > 0) return { ok: true, booted: false, reason: 'already_warm' };
  const out = await scaleRing(env, { now, demand: 1, fetchImpl });
  if (out.dispatched.length > 0) {
    await db(env).prepare(
      "INSERT INTO zen_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
    ).bind('last_boot_at', String(now)).run();
  }
  return { ok: true, booted: out.dispatched.length > 0, reason: out.reason, dispatched: out.dispatched };
}

// Wait for an in-flight task: the caller's watchdog fired (504) but the job is still working, and
// the answer lands in the same row. Polling it is the honest "retry" — starting a second task for
// the same request would spend the pool's budget twice.
export async function ringWaitForTask(env, taskId, { deadlineMs = 60_000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  let step = 0;
  for (;;) {
    const ids = Array.isArray(taskId) ? taskId : [taskId];
    const rows = await Promise.all(ids.map(id => readTask(env, String(id || ''))));
    if (rows.every(row => !row)) return { ok: false, data: { error: 'unknown task' } };
    const winner = rows.find(row => row && row.state === 'done' && (row.ok || row.tool_calls));
    const terminal = rows.every(row => !row || row.state === 'done' || row.state === 'failed' || row.state === 'expired');
    const row = winner || rows.find(row => row);
    if (winner || terminal) {
      return {
        ok: row.state === 'done',
        data: {
          task_id: row.id, model: row.model, ok: !!row.ok, text: row.text || null, kind: row.kind,
          error: row.error, provider_ms: row.provider_ms, served_ms: row.served_ms,
          worker_id: row.worker_id,
          ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) } : {}),
          ...(row.usage ? { usage: JSON.parse(row.usage) } : {}),
          ...(row.finish_reason ? { finish_reason: row.finish_reason } : {}),
        },
      };
    }
    if (Date.now() >= deadline) {
      return { ok: false, data: { error: 'task still running', task_id: row.id, state: row.state } };
    }
    await sleep(backoffMs(step++));
  }
}

// POST /zen/pool/invoke {model, messages?, prompt?, tools?, max_tokens?, wait_ms?} — the whole
// point: one HTTP call, one answer, no job per call. 200 {text} | 504 {task_id} (answer still
// lands, fetch it) | 503 (no warm worker) | 409 (quarantine) | 429 (budget).
export async function zenRingInvoke(request, env, fetchImpl = fetch) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > BODY_MAX_BYTES) return j(413, { error: 'body too large' });
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const { status, data } = await ringInvoke(env, body, fetchImpl);
  return j(status, data);
}

// GET /zen/pool/result/{task_id} — the answer whenever it lands, including after a 504.
export async function zenRingResultById(request, env, taskId) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const row = await readTask(env, String(taskId || ''));
  if (!row) return j(404, { error: 'unknown task' });
  return j(200, {
    task_id: row.id, model: row.model, state: row.state, ok: row.ok, text: row.text || null,
    kind: row.kind, error: row.error, provider_ms: row.provider_ms, served_ms: row.served_ms,
    worker_id: row.worker_id, wait_ms: row.wait_ms, enqueued_at: row.enqueued_at,
    claimed_at: row.claimed_at, finished_at: row.finished_at, wait_returned_at: row.wait_returned_at,
    ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) } : {}),
    ...(row.usage ? { usage: JSON.parse(row.usage) } : {}),
    ...(row.finish_reason ? { finish_reason: row.finish_reason } : {}),
  });
}

// GET /zen/pool/metrics — the autoscaler's inputs and its verdict, in one place. This is what the
// scheduled scale workflow reads and what an operator reads when asking "why is the pool this big".
export async function zenRingMetrics(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  const now = nowMs(env);
  const ceiling = poolCeiling(env), reserve = poolReserve(env), ttl = poolTtl(env);
  const live = (await readLiveWorkers(env, now)).length;
  const queued = await readQueued(env);
  const inflight = await readInflight(env, now);
  const lambda = await readLambda(env, now);
  const decision = scaleDecision({
    lambdaPerMin: lambda.perMin, queued, live, inflight, ceiling, reserve,
    serviceMs: Number(env.ZEN_POOL_SERVICE_MS) || SERVICE_MS_DEFAULT,
  });
  return j(200, {
    now, service: 'zen-rings', lambda_per_min: Number(lambda.perMin.toFixed(3)), lambda_count: lambda.count,
    window_ms: lambda.windowMs, queued, workers_live: live, inflight, ceiling, reserve, ttl_ms: ttl,
    autoscale: String(env.ZEN_POOL_AUTOSCALE || 'on').toLowerCase() !== 'off',
    ...decision, dispatches: await recentDispatches(env, 10),
  });
}

// POST /zen/pool/scale {demand?} — run the autoscaler now. The scheduled workflow calls this; so
// does /zen/pool/invoke on a cold ring. Idempotent in effect: a worker already booting counts as
// in-flight, so a second call inside the boot window dispatches nothing.
export async function zenRingScale(request, env, fetchImpl = fetch) {
  const auth = await authorized(request, env);
  if (!auth.ok) return j(auth.status, { error: auth.reason });
  if (!env.ZEN_DB) return j(503, { error: 'zen database not configured' });
  let body = {};
  try { body = JSON.parse(await request.text() || '{}'); } catch { return j(400, { error: 'bad json' }); }
  const demand = Math.min(Math.max(Number(body?.demand) || 0, 0), RING_CEILING);
  const out = await scaleRing(env, { now: nowMs(env), demand, fetchImpl });
  return j(out.ok ? 200 : 503, out);
}

// GET /zen/pool/health — how many jobs are live right now (no auth, like /zen/health).
export async function zenRingHealth(request, env) {
  const now = nowMs(env);
  const out = { service: 'zen-rings', ok: !!env.ZEN_DB, workers_live: 0, workers: [], queued: 0,
    ceiling: poolCeiling(env), reserve: poolReserve(env), ttl_ms: poolTtl(env), default_wait_ms: DEFAULT_WAIT_MS };
  if (env.ZEN_DB) {
    try {
      out.workers = (await readLiveWorkers(env, now)).map((w) => ({
        worker_id: w.worker_id, repo: w.repo, egress_ip: w.egress_ip, tasks_served: w.tasks_served,
        idle_for_ms: now - Number(w.registered_at || now), lease_expires_in_ms: Number(w.lease_expires_at) - now,
      }));
      out.workers_live = out.workers.length;
      out.queued = (await db(env).prepare('SELECT COUNT(*) AS n FROM zen_pool_tasks WHERE state = ?1').bind('queued').first())?.n ?? 0;
    } catch (e) { out.error = String(e?.message || e).slice(0, 120); }
  }
  return j(200, out);
}

function taskRow(t) {
  return {
    id: t.id, model: t.model, prompt: t.prompt, max_tokens: t.max_tokens, wait_ms: t.wait_ms,
    enqueued_at: t.enqueued_at,
    ...(t.messages ? { messages: JSON.parse(t.messages) } : {}),
    ...(t.tools ? { tools: JSON.parse(t.tools) } : {}),
    ...(t.options ? { options: JSON.parse(t.options) } : {}),
  };
}
