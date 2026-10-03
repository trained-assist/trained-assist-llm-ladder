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

zen free — анонимный тир с **невидимой** квотой: провайдер метрит её против IP, но **по каждой модели отдельно**. Если просто слать запросы, то:

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
| R4 | На 429 — классифицировать лимит и записать `cooldownUntil` (§5). |
| R5 | Пока `cooldownUntil` в будущем — не слать запросы вообще (short-circuit без сети). |
| R6 | Различать 403 (подпись), 429 (лимит) и 5xx/таймаут (ошибка) — разные `kind`. |
| R7 | Отдавать машиночитаемое состояние: `state()` и `summary()` для step summary/артефакта. |
| R8 | Уметь персистить состояние между шагами/ранами (файл → артефакт), чтобы fixed-egress не перебирал квоту. |
| R9 | Не логировать подпись/тело запроса целиком; никаких ключей (их тут нет). |
| R10 | **Соблюдать контекст модели до отправки** (§4): считать `prompt + max_tokens` против капа модели и не слать заведомо непроходящий запрос. |
| R11 | Быть **модель- и провайдер-осознанным** (§4): кап и поведение зависят от модели; клиент держит таблицу капов, а при недетерминированности берёт **минимум**. |

---

## 2. Входные факты о лимитах (из #106)

Три лимита, все считают **запросы** (не токены), все метрятся против IP **отдельно на каждую модель** (§4):

| лимит | как выглядит 429 | порог | сброс |
|---|---|---|---|
| **rate** (провайдер) | голый 429, тело `Error from provider (Console)`, без `retry-after` | ~90–95 запросов/мин с IP на модель | короткий, но после трипа cooldown длинный (>100 мин наблюдалось) |
| **daily** (провайдер) | тот же голый 429 | ~915–965 запросов/день с IP на модель | полночь (предположительно) |
| **daily** (zen) | 429 **с `retry-after`**, тело без `(Console)` | ~940 запросов/день с IP на модель | `retry-after` тикает ровно до **00:00 UTC** |

Ключевое:

- **IP, не подпись.** Заблокированный IP остаётся 429 и с другим `user-agent`.
- **Лимит — per (IP, модель), а не один общий.** На одном relay-IP `mimo`/`big-pickle`
  отдавали 429, а `nemotron` отвечал — трип одной модели не глушит другую. Счётчики ключуются
  по модели (§4).
- **Два параллельных раннера не пересекаются** — у каждого свой бюджет (проверено: 894 и 884 запроса, каждый свой).
- **Единица — запросы.** 100 запросов × 2048 токенов = 219 800 токенов прошли без 429; а «ping»-бурст трипал на ~126K токенов / ~890 запросов.
- **403 ≠ 429.** 403 `FreeTierError` — неверная подпись; 429 — лимит. Не смешивать.
- **Четвёртый лимит — контекст.** Тоже per-model, но проверяется **до** отправки, а не по 429
  (§4). У `mimo-v2.6-flash-free` кап 1 048 576, у `big-pickle` — минимум 262 139 (нестабильно).

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

## 4. Контекст и провайдер — не отправить больше, чем модель съест

Кап контекста **зависит от модели**, а не от тира: у одной zen-модели миллион, у другой —
262K, а одна балансируется между бэкендами с разными капами. Поэтому клиент держит таблицу
капов и **сам проверяет промпт до отправки**, а не ловит `400` от сервера.

### Таблица капов (измерено живьём, `zen-limit-probe.mjs --fill-tokens`)

| модель (zen free) | кап, токенов | стабильность |
|---|---|---|
| `mimo-v2.6-flash-free` | 1 048 576 | стабильно |
| `mimo-v2.5-free` | 1 048 576 | стабильно |
| `nemotron-3.5-lightning-free` | 1 000 000 | стабильно |
| `big-pickle` | **262 139** | **нестабильно**: бэкенды с капом 262 139 и ≥1M, какой достанется — недетерминировано |

**Правило: при недетерминированности берём МИНИМУМ.** `big-pickle` → 262 139, а не 1M:
обещать клиенту миллион, когда запрос может попасть на 262K-бэкенд, — это ложная надёжность.
Максимум недетерминированной модели не гарантия, а удача.

Капы **не берутся из доков** — zen `/v1/models` не отдаёт `context_length` вообще (только
`{id, object, created, owned_by}`). Значение для каждой новой модели измеряется `--fill-tokens`
и вносится в таблицу. Старое значение в любом датафайле — не источник.

### Проверка перед отправкой

Кап — это **весь** запрос: `prompt_tokens + max_tokens ≤ cap`. Если не влезает, сервер
вернёт `400 ... Input token count (N) exceeds the model's maximum context length of (cap),
no tokens left for generation`. Клиент считает сам и **не отправляет** такой запрос.

```js
// Оценка токенов без зависимости от токенизатора: ~3.5 симв/токен (англ. ~4, кириллица ~2.5)
// — намеренно консервативно (переоцениваем), чтобы не уехать за кап.
const estTokens = (s) => Math.ceil(String(s || '').length / 3.5);
const MSG_OVERHEAD = 4;                    // роль + служебные токены на сообщение

const CONTEXT = {                          // модель → кап (МИНИМУМ, если нестабильно)
  'mimo-v2.6-flash-free': 1048576,
  'mimo-v2.5-free': 1048576,
  'nemotron-3.5-lightning-free': 1000000,
  'big-pickle': 262139,                    // floor, не максимум
};

function contextCheck(model, messages, maxTokens) {
  const cap = CONTEXT[model];
  if (!cap) return { ok: true, unknown: true };                 // нет в таблице → решает сервер
  const input = messages.reduce((n, m) => n + estTokens(m.content) + MSG_OVERHEAD, 0);
  const need = input + maxTokens;
  return need <= cap ? { ok: true, input, cap }
                     : { ok: false, input, cap, maxTokens, over: need - cap };
}
```

В `chat()` проверка идёт **до** сети:

- влезает → отправляем;
- не влезает → `{ ok:false, kind:'context', cap, input, maxTokens, over }`, **без запроса**;
- опционально `truncate: true` — выкидывать самые старые не-`system` сообщения, пока не влезет
  (и помечать в отчёте, что контекст подрезан).

`kind:'context'` — это **не** лимит: cooldown не ставится, модель не виновата. Джоба либо
уменьшает промпт, либо выбирает модель с большим капом (таблица это позволяет), либо честно
падает.

### Провайдер = модель, и лимит тоже от него

zen маршрутизирует по `model`, так что **выбор модели и есть выбор провайдера**. И лимиты
привязаны к провайдеру, а не только к IP:

- **кап контекста** — per-**model** (таблица выше);
- **rate / дневная квота** — тоже per-**model**: у каждого провайдера свой бюджет на этот IP.
  На одном и том же relay-IP в одном прогоне `mimo-v2.6` / `mimo-v2.5` / `big-pickle`
  отдавали 429, а `nemotron-3.5-lightning` продолжал отвечать — значит трип одной модели
  **не** глушит другую.

IP при этом остаётся: он — идентификатор клиента, против которого провайдер считает бюджет
(репутация IP гейтит сам тир, §2). Поэтому состояние клиента (rate-окно, счётчик, cooldown)
**ключуется по модели** — и по egress-IP, если джоба ходит с нескольких. Нельзя держать один
общий счётчик на все модели: это занизит бюджеты и не покажет, какой провайдер лёг.

Практический вывод для клиента: `model` — обязательный параметр каждого вызова, а `state()` и
`summary()` разбиты по моделям (`byModel`), а не свалены в один счётчик.

---

## 5. Как понять, что дошёл до лимита

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

**«Знать заранее», а не только по 429:** локальный губернатор (§6) не даёт дойти до
rate-лимита, а счётчик `dailyBudget` — до дневной квоты. Тогда `summary()` честно говорит
`stoppedBy: 'local-rate' | 'local-budget' | 'remote-daily' | 'remote-provider'`.

---

## 6. Губернатор скорости

**Скользящее окно 60 с — своё на каждую модель** (rate-лимит ≈ 90–95/мин и он per-model, §4):

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

class Governors {
  constructor(perMin) { this.perMin = perMin; this.byModel = new Map(); }
  async wait(model) {
    if (!this.byModel.has(model)) this.byModel.set(model, new RateWindow(this.perMin));
    return this.byModel.get(model).wait();
  }
}
```

Рекомендации:

- `ratePerMin = 80` — запас ~15 % под нижнюю оценку 90.
- Конкурентность **≤ 4** на раннер; окно — общее на процесс, но **по одной модели** (не
  свалить все модели в одно окно — иначе словишь rate-лимит на конкретном провайдере).
- Один раннер = один процесс = один набор окон. Не разносить вызовы по нескольким async-пулам
  без общего набора.

---

## 7. Бюджет и персистентность

Два режима — выбрать по типу egress:

**A. GitHub-hosted runner (рекомендуется).** Каждый прогон — свежий Azure-IP, своя квота.
`dailyBudget = 800` **на модель** (запас под ~940 per-model). Персистентность между ранами
**не нужна**; состояние живёт в пределах рана, в конце кладётся в артефакт для истории.

**B. Fixed egress** (self-hosted runner, relay VM, NAT-пул). Квота общая и переживает раны.
Тогда:

- `dailyBudget` = твоя доля, а не 800 (например, ≤100, если делишь с продом);
- состояние читается в начале и пишется в конце (`zen-state.json`) — **разбито по моделям**,
  потому что бюджет per-model (§4): `{ day, models: { <model>: { calls, cooldownUntil } } }`;
- `day` = текущие сутки UTC; при смене суток счётчики сбрасываются;
- при `models[m].calls >= dailyBudget` — стоп по этой модели до 00:00 UTC (другие модели
  продолжают, если у них бюджет цел).

```js
function loadState(file) {
  const today = new Date().toISOString().slice(0, 10);
  const fresh = () => ({ day: today, models: {} });
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s.day === today ? s : fresh();          // новый UTC-день → сброс счётчиков
  } catch { return fresh(); }
}
function budget(model, st) {
  const m = st.models[model] || (st.models[model] = { calls: 0, cooldownUntil: 0 });
  return m;
}
```

> Если задача требует больше 800 запросов — **не поднимай бюджет**, а разложи работу на
> матрицу раннеров: у каждого свой IP и своя квота (проверено, что они не пересекаются).

---

## 8. Интерфейс модуля

```js
// zen-client.mjs (ESM, без зависимостей — node:crypto + fetch)
export function createZenClient({
  base = 'https://opencode.ai/zen/v1',
  ratePerMin = 80,
  dailyBudget = 800,
  providerCooldownMs = 60 * 60 * 1000,
  context = CONTEXT,            // модель → кап контекста (§4), МИНИМУМ при нестабильности
  truncate = false,             // true → подрезать старые сообщения вместо kind:'context'
  state = null,                 // { day, calls, cooldownUntil } для режима B
} = {}) {
  return {
    async chat({ model, messages, tools = [], maxTokens = 1500, timeoutMs = 90_000 }) { /* → Result */ },
    contextCap(model),          // кап модели из таблицы (или null)
    state(),    // { day, models: { <model>: { calls, ok, limited, cooldownUntil, lastKind, lastRetryAfterSec } } }
    summary(),  // { byModel: { <model>: { calls, ok, limited, stoppedBy, cooldownUntil } } }
  };
}
```

`Result`:

```js
{ ok: true,  message, usage, finish_reason, ms }
{ ok: false, kind: 'cooldown'|'rate'|'provider'|'daily'|'fingerprint'|'context'|'error'|'timeout',
  status?, retryAfterSec?, cooldownUntil?, error?,
  cap?, input?, maxTokens?, over? }   // поля kind:'context' — что не влезло и насколько
```

`kind:'context'` ставится **без сетевого вызова** (§4) и cooldown не трогает: это не лимит
тира, а «промпт больше, чем модель съест». `stoppedBy` его не учитывает.

`stoppedBy` в `summary()` **по каждой модели**: `null` | `'local-rate'` | `'local-budget'` |
`'remote-daily'` | `'remote-provider'`. Это и есть «сам знаю, что дошёл» — и по какому
провайдеру именно.

---

## 9. Встраивание в job

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
- на 429 не писать «0/N» как качество — писать «не измерено: лимит» (§11).

---

## 10. Несколько раннеров (фан-аут)

Матрица даёт независимые бюджеты, но помни:

- **Каждый раннер = свой IP и своя квота.** Пересечения нет (проверено на двух параллельных
  раннерах: 894 и 884 запроса, каждый свой).
- Дели работу между раннерами **заранее**, а не «кто первый добежит».
- Раннеры могут попасть в общий NAT-пул (редко на GitHub-hosted). Признак: оба встали на
  429 примерно на одном счётчике — тогда фан-аут не даёт выигрыша, и это видно в отчёте.
- `dailyBudget` ставь **на раннер**, а не на джобу.

---

## 11. Мониторинг и отчёт

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

## 12. Приёмка (тест-план)

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
8. **Контекст (сами, без сети).** Промпт на 300K токенов для `big-pickle` (кап-минимум
   262 139) → `{ok:false,kind:'context',cap:262139,over:…}` **без запроса**; тот же промпт
   для `mimo-v2.6-flash-free` (кап 1 048 576) → уходит в сеть и получает 200.
9. **Кап-таблица не устарела.** Для каждой модели из таблицы `--fill-tokens` подтверждает кап;
   расхождение (модель стала стабильнее/кап вырос) → обновить таблицу, а не «взять максимум».
10. **Нестабильная модель — минимум.** Для `big-pickle` клиент никогда не обещает больше
    262 139, даже если часть запросов проходит на ≥1M-бэкенд.
11. **Лимиты не пересекаются между моделями.** Довести одну модель до 429, тут же вызвать
    другую с того же IP → вторая отвечает 200 (в бенче так и было: `mimo`/`big-pickle` 429,
    `nemotron` 200). Счётчик/cooldown одной модели не должен глушить другую.

---

## 13. Ссылки

- `trained-assist-llm-ladder#106` — исследование лимитов и подписи.
- [`docs/free-tier-limits.md`](free-tier-limits.md) — сводная таблица лимитов.
- [`scripts/zen-limit-probe.mjs`](../scripts/zen-limit-probe.mjs) — эталонная проба + `aggregateSse`.
- `trained-assist-free-models-benchmark#17` — тот же приём в бенче (`zenCall` + `errorKind`).
