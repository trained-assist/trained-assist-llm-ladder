# Requirements log — trained-assist-llm-ladder

- [реализовано] Отдельный сервис лестницы моделей для служебных LLM-вызовов — владелец 2026-09-27: «репозиторий trained-assist-llm-ladder … как апи будем дёргать», домен llm-ladder.trainedassist.store.
- [реализовано] Serverless на Cloudflare Worker, без VM — владелец: «полностью серверлесс … на воркере клаудфлара без vm». Состояние в Durable Object.
- [реализовано] Порядок лестницы deepseek: mimo-v2.6-flash → deepseek-v4.1-flash → muse-spark-1.3-contributor → OpenRouter последней (платная).
- [реализовано] Два ключа OpenCode Go с ротацией; обе на паузе → Go-ступени пропускаются до оживания ключа, потом автоматически обратно на Go.
- [реализовано] Бэкофф по модели: у каждой ступени свой отсчёт 15с → 30с → 60с …
- [реализовано] Вторая лестница `free` (alias `free-ladder`) — перенос недоделанного free-ladder gateway из trained-assist-agent (#1526): Go cheap → OpenRouter :free, стриминг SSE (ступень выбирается до первого токена), tools как есть, ретрай без response_format на 400.
- [реализовано] pr-autofix (фиксер) v1.6.0 ходит в `free-ladder`, своя копия лестницы удалена; потребители (trained-assist-agent, software-engineering-playbooks) передают org-секрет `LLM_LADDER_TOKEN`.
- [реализовано] opencode как клиент `free-ladder` проверен вживую: tool call `read` + ответ, 15 с.
- [реализовано] Из trained-assist-agent выпилены локальные копии: in-process лестница service-llm, `llm-gateway.js`, `infra/llm-edge` (домен llm.trainedassist.store снят).
- [планируется] Бенчмарки (trained-assist-free-models-benchmark) гонять регулярно и по ним обновлять порядок ступеней.
- [планируется] OpenCode-раннер на VM читает здоровье моделей из этого сервиса (сейчас у него своё локальное).
