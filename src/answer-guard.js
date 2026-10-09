// A punctuation-only placeholder is the same failure as an empty answer.
// Do not reject useful short answers such as YES/NO, a number, or an emoji.
export function isEmptyAnswer(content) {
  const text = String(content ?? '').trim();
  return !text || /^[.!?…]+$/u.test(text);
}
