#!/usr/bin/env node
// Ladder watch — is the ladder answering, and is zen answering through it.
//
// Three probes, because "the ladder works" and "zen works" are different claims:
//   1. GET  /health                          the worker is up and knows its ladders
//   2. POST /v1/chat/completions (unpinned)  the real caller path — whatever rung answers
//   3. POST /v1/chat/completions (pinned to zen-rings/nemotron-3-ultra-free)
//                                            zen specifically: the head rung of every text ladder
//
// Telegram fires on a STATE TRANSITION only — down→notify, up→notify — never on every tick,
// so a two-hour outage is two messages, not twelve. The state file is the whole memory:
// GitHub Actions has none across runs, so the workflow restores/saves it via actions/cache.
//
// Usage:
//   node scripts/ladder-watch.mjs [--state watch-state.json] [--notify] [--base URL]
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are read only when --notify is passed.
//
// Exit: 0 all green, 1 a probe failed, 2 could not probe at all.
import fs from 'node:fs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const has = (n) => process.argv.includes(`--${n}`);

const BASE = String(arg('base', process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store')).replace(/\/+$/, '');
const STATE_FILE = arg('state', 'watch-state.json');
const NOTIFY = has('notify');
const ZEN_RUNG = arg('zen-rung', 'zen-rings/nemotron-3-ultra-free');
const LADDER = arg('ladder', 'service');
const PROBE_TIMEOUT_MS = Number(arg('timeout', 45_000));
const TOKEN = (process.env.LADDER_TOKEN || '').trim();
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();

const auth = { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };

async function probe(name, fn, tries = 1) {
  const t0 = Date.now();
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fn();
      last = { name, ok: !!r.ok, ms: Date.now() - t0, detail: r.detail || '' };
    } catch (e) {
      last = { name, ok: false, ms: Date.now() - t0, detail: String(e?.message || e).slice(0, 200) };
    }
    if (last.ok) return last;
    if (i < tries) await new Promise((r) => setTimeout(r, 2_000));
  }
  // zen answers 200 with an EMPTY body often enough that one flake would flap the alert stream
  // every few minutes — the ladder itself retries a rung once before walking on, so the watch
  // does the same before it calls anything down.
  if (tries > 1) last.detail = `${last.detail} (after ${tries} tries)`;
  return last;
}

async function health() {
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const j = await r.json();
  return { ok: r.ok && j.ok === true, detail: r.ok ? `build=${String(j.build || '').slice(0, 12)}` : `HTTP ${r.status}` };
}

async function chat({ pinned }) {
  const body = {
    model: LADDER,
    messages: [{ role: 'user', content: 'Ответь одним словом: ок' }],
    max_tokens: 20,
    // Attributed in /v1/analytics — the ladder logs what the header says, and a monitor that
    // cannot be told apart from real traffic makes its own calls look like user failures.
    'x-ladder-app': 'ladder-watch',
    ...(pinned ? { ladder_rung: ZEN_RUNG } : {}),
  };
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* a non-JSON body is itself a failure below */ }
  if (!r.ok || j?.error) {
    // `every rung failed` is only useful with the per-rung reasons: the attempts array is where
    // `zen-rings: ok (finish=…, out=…)` and `HTTP 402: insufficient credits` live, and a single
    // first attempt made a dead paid tail indistinguishable from a cold ring.
    const ats = (j?.error?.attempts || [])
      .map((a) => `${String(a.model || '').split('/').pop()}: ${a.error || a.outcome || '?'}`)
      .join(' | ');
    const detail = ats || j?.error?.message || text.slice(0, 160);
    return { ok: false, detail: `HTTP ${r.status} ${detail}`.trim() };
  }
  const content = j?.choices?.[0]?.message?.content ?? '';
  if (!String(content).trim()) return { ok: false, detail: `HTTP 200 but empty content (model=${j?.model})` };
  return { ok: true, detail: `${j.model} ${String(content).trim().slice(0, 24)}` };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n'); } catch { /* a read-only workspace must not fail the check */ }
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return { sent: false, why: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: text.slice(0, 4000), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { sent: false, why: `telegram HTTP ${res.status}` };
  return { sent: true };
}

const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function main() {
  const probes = [
    await probe('health', health),
    await probe('ladder', () => chat({ pinned: false }), 2),
    await probe('zen', () => chat({ pinned: true }), 2),
  ];
  const down = probes.filter((p) => !p.ok);
  const status = down.length ? 'down' : 'ok';

  const lines = probes.map((p) => `${p.ok ? 'ok  ' : 'FAIL'} ${p.name.padEnd(7)} ${String(p.ms).padStart(5)}ms  ${p.detail}`);
  console.log(lines.join('\n'));

  const state = readState();
  const now = Date.now();
  const changed = status !== state.last_notified;
  let notice = '';

  if (status === 'down') {
    if (!state.down_since) state.down_since = now;
    if (changed) {
      notice = [
        '🔴 llm-ladder не отвечает',
        `с ${stamp(state.down_since)} (проверка ${stamp(now)})`,
        '',
        ...down.map((p) => `— ${p.name}: ${p.detail} (${p.ms} мс)`),
        '',
        `всего проверок зелёных: ${probes.length - down.length}/${probes.length}`,
        `${BASE}`,
      ].join('\n');
    }
  } else if (state.last_notified === 'down') {
    const since = state.down_since || now;
    notice = [
      '🟢 llm-ladder снова отвечает',
      `простой был ${Math.max(1, Math.round((now - since) / 60000))} мин (${stamp(since)} → ${stamp(now)})`,
      `все ${probes.length} проверки зелёные: ${probes.map((p) => p.detail).join(' · ')}`,
    ].join('\n');
    delete state.down_since;
  } else {
    delete state.down_since;
  }

  let notified = { sent: false, why: 'no transition' };
  if (notice && NOTIFY) notified = await sendTelegram(notice);
  else if (notice) notified = { sent: false, why: '--notify not passed' };

  state.last_notified = status;
  state.checked_at = now;
  writeState(state);

  if (notice) console.log(`\ntransition ${state.last_notified}: ${notice.split('\n')[0]}`);
  console.log(`telegram: ${notified.sent ? 'sent' : `skipped (${notified.why})`}`);
  process.exitCode = down.length === probes.length ? 2 : down.length ? 1 : 0;
}

main().catch((e) => {
  console.error(`watch failed: ${String(e?.message || e)}`);
  process.exitCode = 2;
});
