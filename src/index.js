// trained-assist-llm-ladder — OpenAI-compatible chat completions over a model ladder
// (OpenCode Go → paid OpenRouter last) for small service LLM calls across trained-assist repos.
//
//   GET  /health                 liveness + ladder names (no auth)
//   GET  /v1/models              ladders as model ids (auth)
//   GET  /v1/state               model health + key rotation snapshot (auth)
//   POST /v1/state/reset-keys    unpark all Go keys + Go rungs (auth, ops lever)
//   POST /v1/chat/completions    body.model = ladder ("deepseek", "deepseek:review") (auth)
//
// Auth: `Authorization: Bearer <LADDER_TOKEN>`. Non-streaming → a normal chat.completion whose
// `model` is the rung that answered (also in `x-ladder-model`). stream:true → SSE relayed from
// the chosen rung (chosen before the first token; no failover after it) — how opencode uses the
// `free-ladder` model. Tools pass through as is. Optional body fields: ladder_timeout_ms (per
// rung, non-stream), ladder_ttfb_ms (stream: first-token window), ladder_total_timeout_ms,
// ladder_rung (benchmarks: pin one rung of the ladder, no failover).
//
// This file is the Worker entry: it wires the Durable Object binding and dispatches to the route
// in src/handler.js (kept free of the Workerd runtime so plain `node --test` can exercise it).

import { handle } from './handler.js';

export { LadderState } from './state-do.js';
export { handle, makeStore } from './handler.js';

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};