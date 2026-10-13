// Provider messages and bodies are not a caller-facing or durable diagnostic contract. Keep the
// rung + outcome + a stable reason/status while dropping arbitrary upstream response text.
export function safeAttemptDiagnostics(attempts = []) {
  return attempts.map((attempt) => {
    const model = String(attempt.model || 'unknown');
    const raw = String(attempt.error || '');
    const outcome = String(attempt.outcome || 'error');
    if (!raw) return { model, outcome };
    const http = /^HTTP\s+(\d{3})\b/i.exec(raw);
    let source = model.startsWith('zen-rings/') ? 'zen_pool' : 'provider';
    let reasonCode = 'provider_error';
    let message = 'provider request failed';

    if (http) {
      reasonCode = 'provider_http_error';
      message = `provider returned HTTP ${http[1]}`;
    } else if (/timeout|timed out|aborterror|no first token in time|before first token/i.test(raw)) {
      reasonCode = 'provider_timeout';
      message = 'provider timed out';
    } else if (/warming up|cold ring|pool_backlog|no warm worker/i.test(raw)) {
      source = 'zen_pool';
      reasonCode = 'provider_capacity';
      message = 'Zen worker capacity unavailable';
    } else if (/empty answer|empty response|invalid json/i.test(raw)) {
      reasonCode = 'provider_empty_response';
      message = 'provider returned no usable answer';
    } else if (/fetch failed|network|socket|econn|tls|upstream request failed/i.test(raw)) {
      reasonCode = 'provider_transport_error';
      message = 'provider connection failed';
    }

    return {
      model,
      outcome,
      source,
      reason_code: reasonCode,
      ...(http ? { http_status: Number(http[1]) } : {}),
      error: message,
    };
  });
}
