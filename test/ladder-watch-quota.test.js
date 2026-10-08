import test from 'node:test';
import assert from 'node:assert/strict';
import { etaMinutes, quotaNotice } from '../scripts/ladder-watch.mjs';

// Три способа заметить, что бесплатный лимит OpenRouter уходит: остаток, темп, факт.
// Замер 2026-10-08: 355/1000 за сутки; шторм способен сжечь остаток быстрее интервала опроса,
// поэтому одного «посмотреть, сколько осталось» — мало.

const NOW = 1_791_500_000_000;
const min = (n) => n * 60_000;

test('etaMinutes: темп только между опросами, сброс счётчика его обнуляет', () => {
  assert.equal(etaMinutes(null, 10, 640, NOW), null, 'первый замер — темпа ещё нет');
  assert.equal(etaMinutes({ used: 400, ts: NOW - min(10) }, 399, 640, NOW), null, 'used ушёл назад — наступил новый день');
  assert.equal(etaMinutes({ used: 400, ts: NOW - 30_000 }, 410, 640, NOW), null, 'интервал меньше минуты — на нём темп не считаем');
  assert.equal(etaMinutes({ used: 400, ts: NOW - min(10) }, 400, 640, NOW), null, 'ничего не сожгли — темпа нет');

  // 100 запросов за 10 мин = 10/мин, осталось 640 → 64 мин
  assert.equal(etaMinutes({ used: 400, ts: NOW - min(10) }, 500, 640, NOW), 64);
  // шторм: 300 за 10 мин = 30/мин, осталось 120 → 4 мин
  assert.equal(Math.round(etaMinutes({ used: 400, ts: NOW - min(10) }, 700, 120, NOW)), 4);
});

test('quotaNotice: факт важнее темпа, темп важнее остатка; молчим в норме', () => {
  const ok = { ok: true, detail: '355/1000 за сутки, осталось 644', used: 355, remaining: 644 };
  const low = { ok: false, detail: '950/1000 за сутки, осталось 50', used: 950, remaining: 50 };

  // факт: провайдер сам сказал «usage limit» — это уже случилось, остальное не важно
  const dead = quotaNotice({ quota: ok, errHit: { error: 'Free usage limit reached', calls: 7 }, prevKey: 'or_free_ok', etaMin: null });
  assert.equal(dead.key, 'or_free_dead');
  assert.match(dead.text, /КОНЧИЛСЯ/);
  assert.match(dead.text, /×7 за час/, 'видно, сколько именно отвалилось');

  // темп: остаток ещё приличный, но он сгорает — предупреждаем ДО исчерпания
  const burn = quotaNotice({ quota: ok, errHit: null, prevKey: 'or_free_ok', etaMin: 30 });
  assert.equal(burn.key, 'or_free_burn');
  assert.match(burn.text, /30 мин/);

  // остаток ниже порога
  const lowNotice = quotaNotice({ quota: low, errHit: null, prevKey: 'or_free_ok', etaMin: null });
  assert.equal(lowNotice.key, 'or_free_low');
  assert.match(lowNotice.text, /под конец/);

  // в норме → в норме: тишина (и на первом прогоне в том числе — иначе CI слал бы пустяк)
  assert.equal(quotaNotice({ quota: ok, errHit: null, prevKey: 'or_free_ok', etaMin: null }).text, null);
  assert.equal(quotaNotice({ quota: ok, errHit: null, prevKey: undefined, etaMin: null }).text, null);

  // провал → норма: зелёное приходит только после реального провала
  const back = quotaNotice({ quota: ok, errHit: null, prevKey: 'or_free_low', etaMin: null });
  assert.equal(back.key, 'or_free_ok');
  assert.match(back.text, /в норме/);

  // квоту прочитать не удалось — не выдумываем ни остаток, ни темп
  assert.equal(quotaNotice({ quota: { skipped: 'or-usage HTTP 503' }, errHit: null, prevKey: 'or_free_ok', etaMin: null }), null);
});
