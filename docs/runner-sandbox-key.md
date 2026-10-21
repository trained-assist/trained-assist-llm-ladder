# Статический ключ Ladder для Runner sandbox

Runner sandbox Worker (`trained-assist-runner-api-sandbox3`) ходит в Ladder одним
постоянным ключом. Этот ключ — обычный персональный ключ Ladder, поэтому все
запросы sandbox-полосы видны в аналитике Ladder как запросы одного пользователя.

| Что | Значение |
|---|---|
| Пользователь Ladder | `ai-agent-runner-sandbox` (роль `user`, только sandbox identity/DB) |
| Ключ | `ai-agent-runner-sandbox` (один именованный ключ, без срока) |
| Cloudflare secret | `LLM_LADDER_TOKEN` на Worker `trained-assist-runner-api-sandbox3` |
| Защищённый файл | `~/agent-tokens/trained-assist/ai-agent-runner-sandbox` (0600) |
| Скрипт | `scripts/runner-sandbox-key.mjs` (`provision` / `verify`) |

Ключ **статичный**: он не перевыпускается на каждый прогон, на каждую пересборку
sandbox и на каждый деплой. Ротация — отдельное осознанное решение.

## Что нельзя делать

- Не выдавать новый ключ на каждый прогон или пересоздание sandbox.
- Не отдавать этот ключ production-пользовательским запускам и не менять
  production secret/DB: он живёт только в sandbox identity/DB.
- Не выводить значение ключа в argv, логи, чат, PR, issue. Скрипт читает и пишет
  его только в защищённый файл и печатает лишь `key_id` — первые 16 hex SHA-256.
- Не путать `key_id` с самим ключом: `key_id` безопасен для evidence, значение — нет.

## Операторский путь

### 1. Выдать ключ (один раз)

```bash
node scripts/runner-sandbox-key.mjs provision \
  --admin-token-file ~/agent-tokens/llm-ladder/token \
  --key-file ~/agent-tokens/trained-assist/ai-agent-runner-sandbox
```

Команда идемпотентна: если пользователь, ключ и защищённый файл уже на месте,
она ничего не перевыпускает и печатает `action: reused`. Пользователь и его первый
ключ создаются одним вызовом `POST /v1/admin/users`; значение возвращается один
раз и сразу попадает в файл с правами 0600.

### 2. Привязать ключ к Worker

```bash
npx wrangler secret put LLM_LADDER_TOKEN --config wrangler.sandbox3.jsonc \
  < ~/agent-tokens/trained-assist/ai-agent-runner-sandbox
```

Значение приходит из файла, поэтому оно не попадает в историю командной строки
и в вывод `wrangler`. Worker после этого отдаёт ключ в run только тем окружениям,
которые входят в `ALLOWED_ENVIRONMENT_NAMES` и в `envAllowlist` конкретного
запроса.

### 3. Перезапустить OpenCode-сервис на host'е Runner

**Это обязательный шаг, а не опциональный.** Runner запускает `opencode run` на
VM host'е, и OpenCode поднимает долгоживущий **detached server**, который
переиспользуется следующими прогонами. Конфигурация провайдера (`apiKey`,
заголовки `x-ladder-trace` / `x-ladder-run`) разворачивается в `{env:...}` **один
раз — при старте этого сервера**. Поэтому:

- смена ключа в Cloudflare secret сама по себе не действует, пока на host'е живёт
  старый detached server: он продолжает слать Ladder старый токен, и аналитика
  показывает `key_hash = NULL` (вызов ушёл от служебного токена, а не от
  персонального ключа);
- вместе с ключом «замерзает» и correlation id: `trace_id` / `run_id` в аналитике
  указывают на run, который поднял сервер, а не на текущий прогон.

Перезапуск сервера на host'е (kill процесса `opencode` + удаление маркера
`~/.config/opencode/service-detached.json` у пользователя runner'а) приводит к
тому, что следующий прогон поднимает свежий сервер уже с текущим окружением:
правильный ключ и правильный `run_id` этого прогона.

Диагностика, если атрибуция снова пропала: в журнале OpenCode на host'е
(`~/.local/share/opencode/log/opencode.log`) один и тот же `run=<id>` сервера
должен обслуживать прогоны; если сервер живёт дольше одного прогона — это он и
заморозил конфигурацию.

### 4. Проверить

```bash
node scripts/runner-sandbox-key.mjs verify \
  --key-file ~/agent-tokens/trained-assist/ai-agent-runner-sandbox \
  --admin-token-file ~/agent-tokens/llm-ladder/token
```

`verify` делает один ограниченный бесплатный вызов (`model: free`,
`max_tokens: 16`) и печатает:

- `call` — HTTP-статус и модель ограниченного пробы;
- `key` — владелец, статус и `last_used_at` ключа из `GET /v1/admin/keys`;
- `attribution` — строки `GET /v1/admin/key-usage?period=15m&key_id=…`: у них
  должен быть `user_id = ai-agent-runner-sandbox`;
- `sandbox_calls` — последние вызовы `GET /v1/calls?user=ai-agent-runner-sandbox`
  с их `run_id`: это и есть evidence, что запросы **через Worker** пришли именно
  от этого ключа.

Команда возвращает ненулевой код, если ограниченный вызов не прошёл или если
аналитика не приписала ключу ни одного вызова.

## Ротация

Ротация — отдельное решение, а не часть автоматики прогона. Она меняет
`key_id` на стороне Ladder, поэтому после неё обязательно повторить шаги 2 и 3
(новый secret + перезапуск OpenCode-сервиса на host'е) и проверить атрибуцию
заново:

```bash
node scripts/runner-sandbox-key.mjs provision --rotate \
  --admin-token-file ~/agent-tokens/llm-ladder/token \
  --key-file ~/agent-tokens/trained-assist/ai-agent-runner-sandbox
```

Прежний ключ выданного пользователя отзывается (`POST /v1/admin/keys/{key_id}/revoke`).
Если защищённый файл потерян, а ключ ещё активен, его значение восстановить
нельзя — Ladder возвращает значение ключа только один раз.

## Ограничения

- Ключ общий для всей sandbox-полосы: в аналитике не видно, какой именно
  пользовательский запуск сделал вызов. Разделение запросов по пользователям —
  отдельная задача (per-run выдача connection по идентичности владельца запуска),
  см. Epic #253.
- Runner не шлёт `x-ladder-app`, поэтому в колонке `app` у вызовов полосы пусто.
