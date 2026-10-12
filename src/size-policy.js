// Size policy — estimate request size for timeout and concurrency planning.
//
// Everything here is measured, not guessed; the numbers say where and when.
//
// ── Bands ───────────────────────────────────────────────────────────────────────────────────
// The owner's plan (2026-10-07): a small context deserves a small budget and a fast kill; a
// mid-size request is raced twice; a large one three times. The estimate
// controls timing and concurrency, never whether a provider receives the input.
export const BANDS = Object.freeze([
  // <2K — один ранг, короткий бюджет. 0.4 (= 8 с при дефолтных 20) оказался впритык: замер
  // 2026-10-08 на естественном промпте дал longcat 7.0 / 8.6 с, и одна попытка из трёх
  // обрывалась ровно на потолке. 0.6 (= 12 с) остаётся на 40 % короче дефолта, но уже выше
  // наблюдаемой латентности — «убить быстро» имеет смысл только если модель успевает ответить
  // здоровой.
  { max: 2_000, count: 1, timeoutFactor: 0.6 },
  { max: 32_000, count: 2, timeoutFactor: 1 },    //  2–32K — гоним две
  { max: 128_000, count: 3, timeoutFactor: 1 },   // 32–128K — гоним три
  { max: Infinity, count: 1, timeoutFactor: 1 },  // >128K — one request
]);

// Cheap UTF-8 estimate for timing and concurrency. The provider decides whether
// the request fits its context window.
export function estimateTokens(body) {
  const m = body?.messages;
  if (!Array.isArray(m) || !m.length) return 0;
  try {
    return Math.ceil(new TextEncoder().encode(JSON.stringify(m)).length / 4);
  } catch { return 0; }
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
// мы только поднимаем пол. Медленный первый токен у большого запроса здесь дороже
// потерявшегося окна failover.
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
