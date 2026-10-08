#!/usr/bin/env node
// make-fat-prompt — собрать реалистичный ЖИРНЫЙ промпт из настоящих данных сессии.
//
// Зачем: тесты и бенчмарки обычно используют 'x'.repeat(N) — но реальный жирный промпт это
// не одинаковые буквы, а история разговора: system + реплики + выводы инструментов. Именно
// так выглядят вызовы в проде (в zen_pool_tasks.max(messages) = 2 000 000 байт — это срез
// нашего же среза, не синтетика), и именно так ломаются потолки и таймауты.
//
// Источники текста (реальные, без генерации):
//   opencode — ~/.local/share/opencode/opencode.db, части сессий типа text и tool;
//   synth    — запасной вариант, если БД нет (работа в CI, чужая машина).
// Содержимое НИКОГДА не печатается и не коммитится — только размеры и итог.
//
// Использование:
//   node scripts/make-fat-prompt.mjs --tokens 300000 --out body.json
//   node scripts/make-fat-prompt.mjs --tokens 300000 --send
//   node scripts/make-fat-prompt.mjs --tokens 50000 --source synth --send
//
// --send шлёт собранное в лестницу и печатает, какой ранг ответил и за сколько: это и есть
// проверка «а держит ли потолок» на конкретном размере.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const has = (n) => process.argv.includes(`--${n}`);

const TARGET_TOKENS = Number(arg('tokens', 300_000));
const SOURCE = arg('source', 'opencode');
const OUT = arg('out', null);
const SEND = has('send');
const BASE = String(arg('base', process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store')).replace(/\/+$/, '');
const LADDER = arg('ladder', 'service');
const RUNG = arg('rung', null);
const TOKEN = (process.env.LADDER_TOKEN
  || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.llm-ladder-token'), 'utf8').trim(); } catch { return ''; } })()).trim();

// Та же оценка, что у лестницы (src/size-policy.js): 4 символа на токен.
const estTokens = (s) => Math.ceil(String(s).length / 4);
const targetBytes = TARGET_TOKENS * 4;

async function realPieces(limit = 400) {
  const dbPath = path.join(os.homedir(), '.local/share/opencode/opencode.db');
  if (!fs.existsSync(dbPath)) return { error: `нет ${dbPath}` };
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch (e) { return { error: `node:sqlite недоступен: ${e.message}` }; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(`
    SELECT json_extract(data, '$.type') AS kind,
           COALESCE(json_extract(data, '$.text'),
                    json_extract(data, '$.state.output')) AS body
    FROM part
    WHERE json_extract(data, '$.type') IN ('text', 'tool')
    ORDER BY length(COALESCE(json_extract(data, '$.text'), json_extract(data, '$.state.output'))) DESC
    LIMIT ?
  `).all(limit);
  db.close();
  const out = [];
  for (const r of rows) {
    const t = typeof r.body === 'string' ? r.body : '';
    // слишком короткое не набирает объём, слишком длинное (base64-скриншоты) — не текст
    if (t.length < 400 || t.startsWith('data:image')) continue;
    out.push({ kind: r.kind, text: t });
  }
  return { pieces: out };
}

function syntheticPieces() {
  const para = 'Функция принимает конфигурацию, проверяет целостность и возвращает отчёт. '
    + 'Ошибка воспроизводится при пустом поле, дальше идёт стек вызовов и повтор. ';
  return { pieces: [
    { kind: 'text', text: para.repeat(600) },
    { kind: 'text', text: ('Комментарий из репозитория: поведение зафиксировано в доке. ').repeat(700) },
  ] };
}

function buildMessages(pieces, tokens) {
  // Собираем так, как это выглядит в реальной сессии: короткий system, затем блоки
  // «инструмент отработал → результат вставлен в историю», и в конце живой вопрос.
  const messages = [
    { role: 'system', content: 'Ты ассистент по разбору кода. Отвечай по фактам из предоставленного контекста.' },
    { role: 'user', content: 'Разбери репозиторий: где ломается, покажи нужные фрагменты.' },
  ];
  let used = 0;
  let i = 0;
  // сначала самые крупные куски — так быстрее набираем объём, как в реальной истории,
  // где предыдущие чтения файлов уже лежат в контексте
  while (used < tokens && i < pieces.length) {
    const p = pieces[i++];
    const room = tokens - used;
    const take = Math.min(p.text.length, room * 4);
    if (take < 200) break;
    const chunk = p.text.slice(0, take);
    if (p.kind === 'tool') {
      // OpenAI требует, чтобы tool-сообщение ссылалось на tool_call_id из предыдущего
      // assistant-сообщения — без этого шлюз отвечает 400 «tool messages must include a
      // non-empty string tool_call_id» (поймано на живом прогоне этого же файла).
      const callId = `call_${i.toString(16).padStart(12, '0')}`;
      messages.push({
        role: 'assistant',
        content: 'Смотрю файл, вставляю результат ниже.',
        tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{}' } }],
      });
      messages.push({ role: 'tool', tool_call_id: callId, content: `tool result (${chunk.length} chars):\n${chunk}` });
    } else {
      messages.push({ role: 'assistant', content: chunk });
    }
    used += estTokens(chunk);
  }
  messages.push({ role: 'user', content: 'Ответь одним словом: готово.' });
  used += estTokens(messages[messages.length - 1].content);
  return { messages, tokens: used };
}

async function send(body) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  return { status: res.status, ms: 0, text };
}

async function main() {
  const src = SOURCE === 'synth' ? syntheticPieces() : await realPieces();
  if (src.error) {
    console.error(`источник недоступен: ${src.error} — используйте --source synth`);
    process.exit(2);
  }
  const { messages, tokens } = buildMessages(src.pieces, TARGET_TOKENS);
  const body = {
    model: LADDER,
    messages,
    max_tokens: 30,
    ladder_timeout_ms: 120_000,
    ...(RUNG ? { ladder_rung: RUNG } : {}),
    'x-ladder-app': 'fat-prompt-bench',
  };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  console.log(`источник   : ${SOURCE === 'synth' ? 'синтетический' : 'opencode.db (реальные части сессий)'}`);
  console.log(`кусков     : ${src.pieces.length}`);
  console.log(`сообщений  : ${messages.length}`);
  console.log(`байт       : ${bytes}`);
  console.log(`токенов    : ~${tokens} (оценка len/4)`);

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(body));
    console.log(`записано   : ${OUT}`);
    return;
  }
  if (!SEND) { console.log('\nбез --out и --send — только оценка (добавьте один из флагов)'); return; }

  console.log('отправка…');
  const t0 = Date.now();
  const r = await send(body);
  const ms = Date.now() - t0;
  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch { /* не-JSON */ }
  if (parsed && !parsed.error) {
    console.log(`ОТВЕТИЛ: ${parsed.model} за ${(ms / 1000).toFixed(1)} с, ${parsed.choices?.[0]?.message?.content?.slice(0, 40) ?? ''}`);
  } else {
    const ats = parsed?.error?.attempts || [];
    console.log(`ОТКАЗ HTTP ${r.status} за ${(ms / 1000).toFixed(1)} с`);
    for (const a of ats) {
      console.log(`  ${String(a.outcome).padEnd(10)} ${a.model}: ${String(a.error || '').slice(0, 100)}`);
    }
    if (!ats.length) console.log(`  ${r.text.slice(0, 200)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
