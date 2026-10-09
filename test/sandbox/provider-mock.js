const MAX_BODY_BYTES = 256 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true, service: 'ladder-budget-provider-mock' });
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') return Response.json({ error: 'not_found' }, { status: 404 });
    if (!env.MOCK_PROVIDER_TOKEN || request.headers.get('authorization') !== `Bearer ${env.MOCK_PROVIDER_TOKEN}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return Response.json({ error: 'input_too_large' }, { status: 413 });
    let body;
    try { body = JSON.parse(raw); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
    if (!Array.isArray(body.messages) || !body.messages.length || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 256) {
      return Response.json({ error: 'invalid_chat_request' }, { status: 400 });
    }
    if (body.stream) {
      const enc = new TextEncoder();
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"sandbox mock reply"}}]}\n\n'));
        controller.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":24,"completion_tokens":3}}\n\n'));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({
      id: 'budget-sandbox-mock', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'sandbox mock reply' }, finish_reason: 'stop' }],
      // Fixed usage intentionally tests reconciliation mechanics; it is not estimator calibration.
      usage: { prompt_tokens: 24, completion_tokens: 3, total_tokens: 27 },
    });
  },
};
