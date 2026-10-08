# Распиливание `src/proxy.js` из context-chunks-mcp: план архитектуры

Статус: план на исполнение (владелец: «начинай готовить распиливание скрипта на модули,
а может на три; напиши план архитектуры»). Код прокси — в
`trained-assist/context-chunks-mcp`; здесь фиксируется разбиение, границы модулей и
порядок миграции. Сам рефакторинг начинается, когда репа владельца допилилась.

Компаньон: [spec-context-proxy-call-graph.md](./spec-context-proxy-call-graph.md) — граф
вызовов (COMPRESS / LLM-REF / липкий пин / ветка нарушения контракта), которому это
разбиение подчинено.

---

## 1. Что уже разбито (и трогать не надо)

| модуль | размер | роль |
|---|---|---|
| `src/types/*.js` | 11 файлов | сжатие по типам: code, logs, web, json, csv, table, go, python, javascript, reasoning, vector-select |
| `src/chunker.js` | 2.5 КБ | нарезка на чанки + статистика |
| `src/staged-compressor.js` | 1.6 КБ | `StagedCompressor` — маршрутизация по типам (json → code → logs → web) |
| `src/cache.js` | 0.8 КБ | `store/get/getStats`, SHA-256, LRU |
| `src/metrics.js` | 2.6 КБ | счётчики запросов |
| `src/mcp-server.js` | 1.4 КБ | MCP-сервер `get_context` |
| `scripts/compression-pipeline.mjs`, `ci-*.mjs`, `test-*.mjs` | — | CLI-прогоны и CI-статистика |

Есть **две** параллельные реализации сжатия: локальные `detectType`/`compress` внутри
`proxy.js` и `StagedCompressor`. Это первое, что надо устранить — см. §4, шаг4.

## 2. Что распиливать: `src/proxy.js` (10.6 КБ) → три модуля

Внутри `proxy.js` сейчас живёт всё подряд: HTTP-сервер, порог, сжатие сообщений, вызов
лестницы, цикл `get_context`, валидатор JSON, цикл ретраев. Три модуля, между которыми
чёткая граница «кто может делать fetch»:

```
src/proxy.js          HTTP-слой: http.createServer, тело запроса, статусы, CORS. Тонкий.
        │
        ▼
src/pipeline.js       Оркестратор: размер → COMPRESS или прямой вызов; терминальные
        │             состояния; ответ клиенту; метрики. Ни одного fetch напрямую.
        ├──► src/compress.js   (обёртка над StagedCompressor + cache)
        │
        └──► src/llm-ref.js    Цикл «прочитай сжатое и попроси ref'ы»: контракт,
                │               липкий пин, потолки обращений и ref'ов, ветка Lfix
                ▼
        src/ladder-client.js   ЕДИНСТВЕННОЕ место, которое делает fetch к лестнице:
                               заголовки, пин, пред-проверка размера, клампы таймаутов
```

Правило границы: **`fetch(LADDER_URL)` вызывается только в `ladder-client.js`.** Всё, что
остальному нужно — это чистая функция `callLadder(opts) → LadderResult`.

## 3. Интерфейсы (формы данных, которые пересекают границы)

```js
// src/compress.js
CompressResult = {
  text: string,                       // сжатое представление
  chunks: [{ id, ref, type, bytes }], // ref'ы в кэш (cache.js)
  stats: { before, after, ratio, type }
}

// src/ladder-client.js
LadderOptions = {
  messages, model?, ladderRung?,      // ladderRung = липкий пин
  maxTokens?, timeoutMs?, totalTimeoutMs?,
  json?,                              // response_format: json_object
  app                                 // 'context-chunks-mcp' → x-ladder-app
}
LadderResult = { ok, status, model, content, toolCalls?, attempts?, error? }

// src/llm-ref.js
RefRequest  = { refs: string[], reason: string }        // что распаковать
Contract    =
  | { kind: 'answer',    answer }
  | { kind: 'need_refs', refs: RefRequest[] }
  | { kind: 'invalid',   raw }                          // нарушение контракта → Lfix

// src/pipeline.js
PipelineResult = { status, body, terminal: 'L0'|'L1'|'L2'|'L3'|'Lfix'|'give_up',
                   stats: { compressed, calls, refs, winner, paidPin } }
```

Всё, что читает env, читается **один раз** в конструкторе/фабрике и передаётся внутрь —
никаких `process.env` в теле функций: иначе тест не подменит порог.

## 4. Порядок миграции (без простоя, каждый шаг — рабочий прокси)

1. **`src/ladder-client.js`** — перенести `callLadder` как есть, добавить туда же
   `x-ladder-app`, клампы `ladder_timeout_ms` / `ladder_total_timeout_ms` / `stream:false`
   и пред-проверку размера из ТЗ (≤350 КБ → пин; ≤900 КБ → пин big-window ранга;
   >900 КБ → отказ распаковки). Поведение не меняется, но весь HTTP к лестнице в одном месте.
2. **`src/llm-ref.js`** — перенести `processWithToolLoop` + `executeToolCalls` +
   `isValidJson`/`extractJson` + `JSON_VALIDATOR_PROMPT`. Здесь же: контракт
   (`answer` / `need_refs` / `invalid`), **липкий пин** (победитель предыдущего вызова;
   платный → пин обязателен), потолок **4 обращений** и **≤3 ref'ов** за раз.
   `GET_CONTEXT_TOOL` переезжает сюда (его шлёт только этот модуль).
3. **`src/pipeline.js`** — `compressMessages` + порог + выбор L0/L1 + терминальные состояния
   + `recordRequest` из `metrics.js`. Возвращает `PipelineResult`.
4. **`src/proxy.js` → тонкий HTTP-слой** (~80 строк): `http.createServer`, чтение тела,
   `pipeline.handle(req)`, статус/тело клиенту. Удалить дублирующие `detectType`/`compress` —
   COMPRESS идёт через `StagedCompressor` (он уже умеет json/reasoning/prose, чего нет в
   локальных функциях).
5. **`src/config.js`** (опционально, если порогов станет больше трёх) — `COMPRESS_THRESHOLD`,
   `COMPRESS_THRESHOLD_BEFORE_PAID`, `MAX_CHUNK_SIZE`, `MAX_REFS_PER_CALL=3`,
   `MAX_LADDER_CALLS=4`, `PIN_FALLBACK='opencode-go/mimo-v2.6-flash'`,
   `BIG_WINDOW_RUNG='openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'`.

Шаги1–4 независимы: каждый можно залить отдельным PR и проверить прогоном
`scripts/test-compress.mjs` + `ci-chunk-stats.mjs`.

## 5. Тестовые швы

- `ladder-client.js` принимает `fetchImpl` (как `src/ladder.js` в лестнице) — тест гоняет
  весь llm-ref-цикл без сети;
- `llm-ref.js` принимает `{ callLadder, unpackRef, now }` — тест проверяет: липкий пин
  (платный победитель → пин обязателен), потолок4 обращений, ≤3 ref'ов, ветку `invalid` → `Lfix`,
  отказ при >900 КБ **до** вызова (иначе лестница уходит в полный обход, §4.2 ТЗ по графу);
- `pipeline.js` принимает `{ compress, llmRef, metrics }` — тест проверяет терминалы
  `L0` (маленький вход), `L1` (ответ сразу), `give_up`.

## 6. Антипаттерны, которых избегаем

- Возврат `fetch` из `llm-ref.js` или `pipeline.js` напрямую (минуя `ladder-client`) —
  ломает единую точку клампов и пред-проверок.
- Внутренние вызовы на адрес прокси — петля (сжатие применится к сжатому).
- Чтение `process.env` в теле функции — не подменяется в тесте.
- «Универсальный» объект возврата без `terminal` — тогда непонятно, каким вызовом ответили
  и сколько платного сгорело.
