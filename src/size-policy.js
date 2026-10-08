// Size policy — how big the request is, what a rung may take, and how many to race.
//
// Everything here is measured, not guessed; the numbers say where and when.
//
// ── Ceilings ────────────────────────────────────────────────────────────────────────────────
// A rung whose window is smaller than the request cannot answer, and the refusal is NOT cheap:
// `opencode-go/*` at ~98K tokens answers 200, at ~123K answers
// `429 "Upstream request failed: Endpoint is unavailable."` and rotates through every key —
// 48 s of wall clock, three keys burned, and the caller still has no answer (measured
// 2026-10-07). So the ladder must not try it in the first place.
//
// zen-rings is governed by a much earlier gate — `ZEN_MAX_INPUT_BYTES` (50 KB) in the ring —
// so its window never comes into play here; `opencode-zen` is retired (README) and keeps its
// entry only so a revived relay is still measured correctly.
export const INPUT_CEILING_TOKENS = {
  'opencode-go/': 100_000,
  'opencode-zen/': 1_000_000,
};

// Anything not named above: no ceiling enforced. Unknown is the safe answer — a wrongly refusing
// rung costs a hop, a wrongly accepting one costs the whole watchdog.
export const NO_CEILING = null;

// ── Bands ───────────────────────────────────────────────────────────────────────────────────
// The owner's plan (2026-10-07): a small context deserves a small budget and a fast kill; a
// mid-size request is raced twice; a large one three times. Tokens, because that is what the
// provider counts and what every cap above is expressed in.
export const BANDS = Object.freeze([
  // <2K — один ранг, короткий бюджет. 0.4 (= 8 с при дефолтных 20) оказался впритык: замер
  // 2026-10-08 на естественном промпте дал longcat 7.0 / 8.6 с, и одна попытка из трёх
  // обрывалась ровно на потолке. 0.6 (= 12 с) остаётся на 40 % короче дефолта, но уже выше
  // наблюдаемой латентности — «убить быстро» имеет смысл только если модель успевает ответить
  // здоровой.
  { max: 2_000, count: 1, timeoutFactor: 0.6 },
  { max: 32_000, count: 2, timeoutFactor: 1 },    //  2–32K — гоним две
  { max: 128_000, count: 3, timeoutFactor: 1 },   // 32–128K — гоним три
  { max: Infinity, count: 1, timeoutFactor: 1 },  //  >128K — один (потолки выше уже отсекли лишнее)
]);

// Cheap pre-flight estimate — but в БАЙТАХ, а не в символах, и это не стилистика.
//
// Шлюз Go режет по телу запроса, а не по токенам. Замер 2026-10-08: 392 КБ отвечает,
// 491 КБ → `429 Upstream request failed: Endpoint is unavailable` с ротацией по всем ключам
// (48 с, три ключа). На русском тексте байты UTF-8 ≈ 1.8 × символы, поэтому оценка
// `String.length / 4` ЗАНИЖАЛА счёт в ~1.8 раза и пропускала запросы, которых шлюз уже
// не принимал: 523 КБ давали «~80K токенов» (в пределах 100 000) и упирались в 429.
//
// `bytes / 4` даёт 400 000 байт при потолке 100 000 — это на ~10 % консервативнее реального
// предела шлюза (~450 КБ). Переплюнуть в безопасную сторону стоит одного пропущенного хопа;
// недоплюнуть — 429 и трёх сожжённых ключей.
//
// Избыточная точность тут не нужна: 4 байта/токен — средняя для английского, и именно поэтому
// множитель остался 4. Важен порядок величины, а не запятая.
export function estimateTokens(body) {
  const m = body?.messages;
  if (!Array.isArray(m) || !m.length) return 0;
  try {
    return Math.ceil(new TextEncoder().encode(JSON.stringify(m)).length / 4);
  } catch { return 0; }
}

// Ceiling for this rung, or null when nothing is known.
export function ceilingFor(model) {
  for (const [prefix, cap] of Object.entries(INPUT_CEILING_TOKENS)) {
    if (String(model).startsWith(prefix)) return cap;
  }
  return NO_CEILING;
}

export function fits(model, tokens) {
  const cap = ceilingFor(model);
  return cap === null || tokens <= cap;
}

// ── TTFB ─────────────────────────────────────────────────────────────────────────────────────
// Окно первого токена должно расти вместе с промптом: у жирного запроса есть префилл, и 15 с ему
// не хватает. Замер 2026-10-08 по трассе за сутки: из 28 отказов `no first token in time` —
// 21 на payload ≥ 100 КБ, медиана 978 830 байт (≈ 245K токенов); на маленьких промптах их 3.
// Последствие видно в инциденте того же дня: обе ступени с большим окном (sante:free 262K и
// nemotron-3-ultra-550b-a55b:free 1M) health-skip'ались именно так, и лестница отвечала
// `every rung failed`, хотя физически промпт в обе умещался.
//
// Почему множитель, а не отдельное окно: вызывающий уже задаёт своё `ladder_ttfb_ms` —
// мы только поднимаем пол. И поднимаем ограниченно: у жирного промпта почти некуда переключаться
// (нижние ступени всё равно не влезают по размеру), поэтому медленный токен здесь дороже, чем
// потерявшееся окно failover.
export function ttfbFactor(tokens) {
  if (tokens < 32_000) return 1;      // до 32K — как и просили
  if (tokens < 128_000) return 2;     // 32–128K — двойное окно
  return 3;                           // >128K — тройное (15 с → 45 с)
}

// The band for a token count: { count, timeoutFactor }.
export function hedgePlan(tokens) {
  const band = BANDS.find((b) => tokens < b.max) || BANDS[BANDS.length - 1];
  return { count: band.count, timeoutFactor: band.timeoutFactor };
}
