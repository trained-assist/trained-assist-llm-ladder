# ТЗ: клиент zen free из GitHub Actions

Как из джобы GitHub Actions **грамотно** обращаться к бесплатным моделям zen
(`opencode.ai/zen/v1`), **самому держаться в лимите** и **самому знать**, что до лимита
дошёл — чтобы 429 не выглядел как «модель плохая».

Источник фактов: исследование `trained-assist-llm-ladder#106`, разбор в
[`docs/free-tier-limits.md`](free-tier-limits.md), рабочий пробник
[`scripts/zen-limit-probe.mjs`](../scripts/zen-limit-probe.mjs). Числа ниже — измеренные,
не оценочные.

---

## 0. Зачем

zen free — анонимный тир с **невидимой** per-IP квотой. Если просто слать запросы, то:

- на бурсте ловишь 429 и не понимаешь, это лимит или модель сломалась;
- на медленной работе тихо упираешься в дневную квоту и получаешь мусорные «0/6» в отчётах;
- при работе через relay-IP делишь квоту с продом и роняешь его.

Задача клиента — сделать обращение **предсказуемым**: держать скорость ниже rate-лимита,
останавливаться до дневной квоты, а на 429 — знать, какой это лимит и когда можно снова.

---

## 1. Требования к клиенту

| # | Требование |
|---|---|
| R1 | Ставить валидную подпись на **каждый** запрос (§3), иначе 403 `FreeTierError`. |
| R2 | Ограничивать скорость: не более `ratePerMin` (по умолчанию **80/мин**) скользящим окном. |
| R3 | Считать запросы и останавливаться до `dailyBudget` (по умолчанию **800** за прогон). |
| R4 | На 429 — классифицировать лимит и записать `cooldownUntil` (§4). |
| R5 | Пока `cooldownUntil` в будущем — не слать запросы вообще (short-circuit без сети). |
| R6 | Различать 403 (подпись), 429 (лимит) и 5xx/таймаут (ошибка) — разные `kind`. |
| R7 | Отдавать машиночитаемое состояние: `state()` и `summary()` для step summary/артефакта. |
| R8 | Уметь персистить состояние между шагами/ранами (файл → артефакт), чтобы fixed-egress не перебирал квоту. |
| R9 | Не логировать подпись/тело запроса целиком; никаких ключей (их тут нет). |

---

## 2. Входные факты о лимитах (из #106)

Три лимита, **все per-IP**, все считают **запросы** (не токены):

| лимит | как выглядит 429 | порог | сброс |
|---|---|---|---|
| **rate** (провайдер) | голый 429, тело `Error from provider (Console)`, без `retry-after` | ~90–95 запросов/мин с IP | короткий, но после трипа cooldown длинный (>100 мин наблюдалось) |
| **daily** (провайдер) | тот же голый 429 | ~915–965 запросов/день с IP | полночь (предположительно) |
| **daily** (zen) | 429 **с `retry-after`**, тело без `(Console)` | ~940 запросов/день с IP | `retry-after` тикает ровно до **00:00 UTC** |

Ключевое:

- **IP, не подпись.** Заблокированный IP остаётся 429 и с другим `user-agent`.
- **Два параллельных раннера не пересекаются** — у каждого свой бюджет (проверено: 894 и 884 запроса, каждый свой).
- **Единица — запросы.** 100 запросов × 2048 токенов = 219 800 токенов прошли без 429; а «ping»-бурст трипал на ~126K токенов / ~890 запросов.
- **403 ≠ 429.** 403 `FreeTierError` — неверная подпись; 429 — лимит. Не смешивать.

---

## 3. Подпись (fingerprint) — что слать

Обязательны **ровно 4 вещи** (остальное — косметика):

| поле | значение |
|---|---|
| `user-agent` | начинается с `opencode/` — версия **не** пиннута (`opencode/9.99.99` проходит) |
| `x-opencode-session` | форма `ses_<12 hex><14 alnum>` — форма валидируется, значение свободно и переиспользуемо |
| `stream` (в теле) | **`true`** обязательно; `false`/отсутствие → 403 |
| `tools` (в теле) | должен содержать **оба** имени: `shell` **и** `read`; схема не проверяется, порядок свободен |

Не нужны: `authorization` (анонимно; `Bearer public` — заглушка), `x-opencode-client`,
`x-opencode-project`, `x-opencode-request`.

```js
const ZEN_UA = 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';
const randHex = n => crypto.randomBytes(n).toString('hex');
const randAlnum = n => { const c='abcdefghijklmnopqrstuvwxyz0123456789', b=crypto.randomBytes(n);
  let s=''; for (let i=0;i<n;i++) s+=c[b[i]%c.length]; return s; };
const SHELL = { type:'function', function:{ name:'shell', parameters:{ type:'object', properties:{ cmd:{type:'string'} }, required:['cmd'] } } };
const READ  = { type:'function', function:{ name:'read',  parameters:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] } } };

const zenHeaders = () => ({
  'content-type': 'application/json',
  'authorization': 'Bearer public',
  'user-agent': ZEN_UA,
  'x-opencode-client': 'cli',
  'x-opencode-project': 'global',
  'x-opencode-request': `msg_${randHex(6)}${randAlnum(12)}`,
  'x-opencode-session': `ses_${randHex(6)}${randAlnum(14)}`,
});
```

Тело: `stream: true` обязательно, поэтому ответ — SSE, и его надо свернуть обратно в
один `chat.completion` (готовый `aggregateSse` — в `scripts/zen-limit-probe.mjs` и в
`trained-assist-free-models-benchmark/scripts/ladder-bench.mjs`). Свои tools (если задача их
шлёт) **мержатся** с `shell`+`read`, иначе 403.

---

## 4. Как понять, что дошёл до лимита

Клиент классифицирует ответ **по коду + заголовку + телу**, не только по статусу:

```js
function classify(res, bodyText) {
  if (res.status === 403) return { kind: 'fingerprint' };            // подпись не прошла
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    if (ra != null) return { kind: 'daily', retryAfterSec: Number(ra) };   // zen daily → 00:00 UTC
    const provider = /from provider \(Console\)/i.test(bodyText);
    return { kind: provider ? 'provider' : 'rate' };                 // без retry-after
  }
  if (res.status >= 500) return { kind: 'error', retryable: true };
  return { kind: 'ok' };
}
```

Правила перехода в cooldown:

| kind | cooldownUntil |
|---|---|
| `daily` | `now + retryAfterSec*1000` — точное время сброса |
| `provider` / `rate` | `now + providerCooldownMs` (по умолчанию **60 мин**; наблюдалось >100 мин — если можешь, ставь 2 ч) |
| `fingerprint` | **не** cooldown: это баг подписи, падать громко (`throw`/exit 1) |
| `error` | обычный ретрай с backoff, лимит не трогать |

После установки `cooldownUntil` любой следующий `chat()` возвращает
`{ ok:false, kind:'cooldown', cooldownUntil }` **без сетевого вызова**. Джоба проверяет это
до вызова и, если время сброса за горизонтом рана, завершается с понятным статусом.

**«Знать заранее», а не только по 429:** локальный губернатор (§5) не даёт дойти до
rate-лимита, а счётчик `dailyBudget` — до дневной квоты. Тогда `summary()` честно говорит
`stoppedBy: 'local-rate' | 'local-budget' | 'remote-daily' | 'remote-provider'`.

---

## 5. Губернатор скорости

**Скользящее окно 60 с** — простое и точное под наш случай (rate-лимит ≈ 90–95/мин):

```js
class RateWindow {
  constructor(perMin) { this.perMin = perMin; this.ts = []; }
  async wait() {
    for (;;) {
      const now = Date.now();
      this.ts = this.ts.filter(t => now - t < 60_000);
      if (this.ts.length < this.perMin) { this.ts.push(now); return; }
      await new Promise(r => setTimeout(r, 60_000 - (now - this.ts[0]) + 50));
    }
  }
}
```

Рекомендации:

- `ratePerMin = 80` — запас ~15 % под нижнюю оценку 90.
- Конкурентность **≤ 4** на раннер; губернатор общий на процесс.
- Один раннер = один процесс = одно окно. Не разносить вызовы по нескольким async-пулам
  без общего окна.

---

## 6. Бюджет и персистентность

Два режима — выбрать по типу egress:

**A. GitHub-hosted runner (рекомендуется).** Каждый прогон — свежий Azure-IP, своя квота.
`dailyBudget = 800` (запас под ~940). Персистентность между ранами **не нужна**; состояние
живёт в пределах рана, в конце кладётся в артефакт для истории.

**B. Fixed egress** (self-hosted runner, relay VM, NAT-пул). Квота общая и переживает раны.
Тогда:

- `dailyBudget` = твоя доля, а не 800 (например, ≤100, если делишь с продом);
- состояние читается в начале и пишется в конце (`zen-state.json`): `{ day, calls, cooldownUntil }`;
- `day` = текущие сутки UTC; при смене суток счётчик сбрасывается;
- при `calls >= dailyBudget` — стоп до 00:00 UTC.

```js
function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    if (s.day !== today) return { day: today, calls: 0, cooldownUntil: 0 }; // новый UTC-день
    return s;
  } catch { return { day: new Date().toISOString().slice(0,10), calls: 0, cooldownUntil: 0 }; }
}
```

> Если задача требует больше 800 запросов — **не поднимай бюджет**, а разложи работу на
> матрицу раннеров: у каждого свой IP и своя квота (проверено, что они не пересекаются).

---

## 7. Интерфейс модуля

```js
// zen-client.mjs (ESM, без зависимостей — node:crypto + fetch)
export function createZenClient({
  base = 'https://opencode.ai/zen/v1',
  ratePerMin = 80,
  dailyBudget = 800,
  providerCooldownMs = 60 * 60 * 1000,
  state = null,                 // { day, calls, cooldownUntil } для режима B
} = {}) {
  return {
    async chat({ model, messages, tools = [], maxTokens = 1500, timeoutMs = 90_000 }) { /* → Result */ },
    state(),    // { calls, ok, limited, cooldownUntil, lastKind, lastRetryAfterSec }
    summary(),  // { calls, ok, limited, stoppedBy, cooldownUntil, byModel: {...} }
  };
}
```

`Result`:

```js
{ ok: true,  message, usage, finish_reason, ms }
{ ok: false, kind: 'cooldown'|'rate'|'provider'|'daily'|'fingerprint'|'error'|'timeout',
  status?, retryAfterSec?, cooldownUntil?, error? }
```

`stoppedBy` в `summary()`: `null` | `'local-rate'` | `'local-budget'` | `'remote-daily'` |
`'remote-provider'`. Это и есть «сам знаю, что дошёл».

---

## 8. Встраивание в job

```yaml
name: zen-direct-job
on:
  workflow_dispatch:
  schedule:
    - cron: '17 */6 * * *'     # каждый ран — свежий IP → своя квота

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }

      - name: zen work
        id: zen
        run: node scripts/my-zen-job.mjs > zen-report.json
        # job-код: client.chat(...) в цикле; на !ok и kind==='cooldown' — break;

      - name: summary
        if: always()
        run: node scripts/zen-summary.mjs zen-report.json >> "$GITHUB_STEP_SUMMARY"

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: zen-report-${{ github.run_id }}
          path: zen-report.json
```

Каркас job-скрипта:

```js
import { createZenClient } from './zen-client.mjs';
const zen = createZenClient({ ratePerMin: 80, dailyBudget: 800 });

const out = { model: 'mimo-v2.6-flash-free', results: [] };
for (const task of TASKS) {
  const r = await zen.chat({ model: out.model, messages: [{ role:'user', content: task }] });
  if (!r.ok) {
    out.results.push({ task, ...r });
    if (r.kind === 'cooldown') break;                 // дошли до лимита — стоп, не молотим
    if (r.kind === 'fingerprint') { process.exitCode = 2; break; }  // подпись сломана — громко
    continue;                                          // error/timeout — пропустить задачу
  }
  out.results.push({ task, ok: true, ms: r.ms, text: r.message.content });
}
out.summary = zen.summary();                            // stoppedBy, cooldownUntil, calls
console.log(JSON.stringify(out, null, 2));
```

Джоба должна:

- на `kind === 'fingerprint'` — **падать** (exit ≠ 0): это регрессия подписи, её нельзя пропустить;
- на `kind === 'cooldown'` — **не падать**: лимит это нормальное состояние, отчёт скажет
  `stoppedBy` и `cooldownUntil`;
- на 429 не писать «0/N» как качество — писать «не измерено: лимит» (§9).

---

## 9. Несколько раннеров (фан-аут)

Матрица даёт независимые бюджеты, но помни:

- **Каждый раннер = свой IP и своя квота.** Пересечения нет (проверено на двух параллельных
  раннерах: 894 и 884 запроса, каждый свой).
- Дели работу между раннерами **заранее**, а не «кто первый добежит».
- Раннеры могут попасть в общий NAT-пул (редко на GitHub-hosted). Признак: оба встали на
  429 примерно на одном счётчике — тогда фан-аут не даёт выигрыша, и это видно в отчёте.
- `dailyBudget` ставь **на раннер**, а не на джобу.

---

## 10. Мониторинг и отчёт

Минимум в step summary:

| поле | зачем |
|---|---|
| `calls`, `ok`, `limited` | сколько сделали / сколько прошло |
| `stoppedBy` | `local-rate` / `local-budget` / `remote-daily` / `remote-provider` |
| `cooldownUntil` (ISO UTC) | когда снова можно |
| `lastRetryAfterSec` | если был `retry-after` |
| разбивка `byModel` | по каждой модели отдельно |

Правило отчётности: **`429` — это ⛔ «не измерено», а не ❌ «провал».** Знаменатель качества —
только `ok`-ячейки. Иначе дневная квота снова превратится в мнимые «0/6».

Опционально: раз в ран писать `{ day, calls, cooldownUntil }` в общий стор (D1 у
`llm-ladder`, endpoint `POST /v1/…`) — тогда несколько джоб на одном egress видят общий счётчик.

---

## 11. Приёмка (тест-план)

1. **Подпись.** 1 запрос с полной подписью → 200. Без `stream:true` → 403 `FreeTierError`
   (клиент рапортует `kind:'fingerprint'`, джоба падает).
2. **Rate.** Губернатор при `ratePerMin=80` держит ≤80 запросов в любое скользящее 60 с
   (замер: пик окна в логе ≤80).
3. **Daily (локальный).** При `dailyBudget=5` шестой вызов возвращает
   `{ok:false,kind:'cooldown',stoppedBy:'local-budget'}` **без сети**.
4. **Remote daily.** Спровоцировать переполнение (например, 1000 запросов с `ratePerMin=200`)
   → первый 429 с `retry-after`; клиент ставит `cooldownUntil = now + retry-after`,
   следующий `chat()` не идёт в сеть. `retry-after` указывает на 00:00 UTC.
5. **Remote provider.** Быстрый бурст без `retry-after` → `kind:'provider'`,
   `cooldownUntil = now + providerCooldownMs`.
6. **Фан-аут.** Два раннера по 800 запросов параллельно — оба не пересекаются (у каждого
   свой бюджет).
7. **Отчёт.** При лимите ячейки помечены ⛔, `stoppedBy` заполнен, знаменатель качества
   не включает лимитные ячейки.

---

## 12. Ссылки

- `trained-assist-llm-ladder#106` — исследование лимитов и подписи.
- [`docs/free-tier-limits.md`](free-tier-limits.md) — сводная таблица лимитов.
- [`scripts/zen-limit-probe.mjs`](../scripts/zen-limit-probe.mjs) — эталонная проба + `aggregateSse`.
- `trained-assist-free-models-benchmark#17` — тот же приём в бенче (`zenCall` + `errorKind`).
