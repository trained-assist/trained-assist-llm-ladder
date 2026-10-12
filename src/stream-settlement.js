// Observe the terminal SSE frame while relaying the exact upstream bytes.
// Usage often arrives only in the final frame, after the first output token.
const MAX_LINE = 64 * 1024;

export function settleStream(stream, onSettle) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let line = '';
  let skipLine = false;
  let doneFrame = false;
  let errorFrame = false;
  let usage = null;
  let settled = false;
  let cancelRequested = false;

  function inspect(value) {
    const text = value.endsWith('\r') ? value.slice(0, -1) : value;
    if (text.startsWith('event:') && text.slice(6).trim() === 'error') errorFrame = true;
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (data === '[DONE]') { doneFrame = true; return; }
    if (!data.startsWith('{')) return;
    try {
      const frame = JSON.parse(data);
      if (frame.error) errorFrame = true;
      if (frame.usage && typeof frame.usage === 'object') usage = frame.usage;
    } catch { /* Relay malformed frames unchanged; completion still needs [DONE]. */ }
  }

  function feed(text) {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      if (end < 0) break;
      const part = text.slice(start, end);
      if (!skipLine && line.length + part.length <= MAX_LINE) inspect(line + part);
      line = '';
      skipLine = false;
      start = end + 1;
    }
    const rest = text.slice(start);
    if (!skipLine && line.length + rest.length <= MAX_LINE) line += rest;
    else { line = ''; skipLine = true; }
  }

  async function finish(reason) {
    if (settled) return;
    settled = true;
    try {
      await onSettle({ complete: reason === 'eof' && doneFrame && !errorFrame, reason, usage });
    } catch { /* Diagnostics must never turn a delivered stream into an error. */ }
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          feed(decoder.decode());
          if (!skipLine && line) inspect(line);
          controller.close();
          await finish('eof');
        } else {
          feed(decoder.decode(value, { stream: true }));
          controller.enqueue(value);
        }
      } catch (error) {
        if (cancelRequested) await finish('cancelled');
        else { controller.error(error); await finish('read_error'); }
      }
    },
    async cancel(reason) {
      cancelRequested = true;
      try { await reader.cancel(reason); }
      finally { await finish('cancelled'); }
    },
  });
}
