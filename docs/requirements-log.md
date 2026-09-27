# Requirements log — trained-assist-llm-ladder

- [реализовано] Отдельный сервис лестницы моделей для служебных LLM-вызовов — владелец 2026-09-27: «репозиторий trained-assist-llm-ladder … как апи будем дёргать», домен llm-ladder.trainedassist.store.
- [реализовано] Serverless на Cloudflare Worker, без VM — владелец: «полностью серверлесс … на воркере клаудфлара без vm». Состояние в Durable Object.
- [реализовано] Порядок лестницы deepseek: mimo-v2.6-flash → deepseek-v4.1-flash → muse-spark-1.3-contributor → OpenRouter последней (платная).
- [реализовано] Два ключа OpenCode Go с ротацией; обе на паузе → Go-ступени пропускаются до оживания ключа, потом автоматически обратно на Go.
- [реализовано] Бэкофф по модели: у каждой ступени свой отсчёт 15с → 30с → 60с …
- [реализовано] Вторая лестница `free` (alias `free-ladder`) — перенос недоделанного free-ladder gateway из trained-assist-agent (#1526): Go cheap → OpenRouter :free, стриминг SSE (ступень выбирается до первого токена), tools как есть, ретрай без response_format на 400.
- [планируется] Подключить pr-autofix (фиксер) к лестнице `free` вместо своей копии FREE_MODEL_LADDER/GO_MODEL_LADDER.
- [планируется] OpenCode-раннер на VM читает здоровье моделей из этого сервиса (сейчас у него своё локальное).
