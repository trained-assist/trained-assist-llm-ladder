// Error-event publisher for trained-assist-error-watcher.
// Fire-and-forget: never throws, never blocks the call path.
// C12 ErrorEvent schema: https://github.com/trained-assist/trained-agent-architecture/blob/main/OBSERVABILITY-AND-ERROR-CONTRACT.md

const SENSITIVE_PATTERNS = [
  /bearer\s+[^\s]+/gi,
  /sk-[a-zA-Z0-9_-]+/gi,
  /token[=:]\s*[^\s,;]+/gi,
  /key[=:]\s*[^\s,;]+/gi,
];

function redact(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

function truncate(text, max = 240) {
  if (!text || typeof text !== 'string') return text;
  return text.length > max ? text.slice(0, max) : text;
}

export function createErrorPublisher({ watcherUrl, watcherKey, environment = 'production' } = {}) {
  if (!watcherUrl || !watcherKey) {
    return { publishError: () => {}, getDroppedCount: () => 0, getSpool: () => [] };
  }

  const spool = [];
  let dropped = 0;

  async function publishError(event) {
    try {
      const res = await fetch(`${watcherUrl.replace(/\/$/, '')}/errors`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-watcher-key': watcherKey,
          'x-watcher-scopes': 'error:write',
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        dropped += 1;
        if (spool.length < 100) spool.push(event);
      }
    } catch {
      dropped += 1;
      if (spool.length < 100) spool.push(event);
    }
  }

  return { publishError, getDroppedCount: () => dropped, getSpool: () => spool.slice() };
}

export function resolveErrorPublisher(env) {
  const url = env.ERROR_WATCHER_URL || env.WATCHER_URL || null;
  const key = env.ERROR_WATCHER_KEY || env.WATCHER_KEY || null;
  if (!url || !key) return null;
  return createErrorPublisher({
    watcherUrl: url,
    watcherKey: key,
    environment: env.ERROR_WATCHER_ENVIRONMENT || 'production',
  });
}

export function buildErrorEvent({ trace, ladder, error, outcome = 'failed', retryable = true }) {
  const eventId = `ladder_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const safeSummary = truncate(redact(error || 'unknown error'));
  return {
    schemaVersion: 1,
    eventId,
    occurredAt: new Date().toISOString(),
    source: {
      service: 'trained-assist-llm-ladder',
      release: null,
      environment: 'production',
    },
    scope: {
      kind: trace?.userId ? 'profile' : 'platform',
      tenantId: null,
      profileId: trace?.userId || null,
    },
    correlation: {
      userTaskId: null,
      runId: trace?.runId || null,
      traceId: trace?.traceId || null,
    },
    replyContext: {
      channel: null,
      destinationRef: null,
      status: 'not_applicable',
    },
    error: {
      code: 'LADDER_ERROR',
      operation: ladder || 'chat/completions',
      severity: 'error',
      retryable,
      outcome,
      safeSummary,
      privateDetailsRef: null,
    },
    origin: {
      kind: 'application',
      incidentId: null,
      diagnosticDepth: 0,
    },
  };
}
