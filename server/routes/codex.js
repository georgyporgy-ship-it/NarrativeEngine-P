import { Router } from 'express';
import { wrapAsync } from '../lib/asyncHandler.js';
import { getCodexProvider } from '../services/codexProvider.js';

function errorStatus(err) {
    const message = String(err?.message || err).toLowerCase();
    if (message.includes('not found') || message.includes('unavailable')) return 503;
    if (message.includes('not signed in') || message.includes('authentication') || message.includes('unauthorized')) return 401;
    if (message.includes('timed out')) return 504;
    return 502;
}

function openAIResponse(result) {
    const message = { role: 'assistant', content: result.content || null };
    if (result.toolCall) {
        message.tool_calls = [{
            id: result.toolCall.id,
            type: 'function',
            function: {
                name: result.toolCall.name,
                arguments: result.toolCall.arguments,
            },
        }];
    }
    return {
        id: result.id,
        object: 'chat.completion',
        model: result.model,
        choices: [{ index: 0, message, finish_reason: result.finishReason }],
        usage: result.usage,
    };
}

function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function createCodexRouter({ provider = getCodexProvider() } = {}) {
    const router = Router();

    router.get('/api/codex/status', wrapAsync(async (_req, res) => {
        res.json(await provider.status({ includeModels: true }));
    }));

    router.get('/api/codex/models', wrapAsync(async (_req, res) => {
        const status = await provider.status({ includeModels: true });
        if (!status.installed || !status.authenticated || status.error) {
            res.status(status.installed ? 401 : 503).json({ error: status.error || 'ChatGPT is not signed in through Codex' });
            return;
        }
        res.json({ object: 'list', data: status.models });
    }));

    router.post('/api/codex/login', wrapAsync(async (_req, res) => {
        try {
            res.json(await provider.beginDeviceLogin());
        } catch (err) {
            res.status(errorStatus(err)).json({ error: err.message });
        }
    }));

    router.post('/api/codex/logout', wrapAsync(async (_req, res) => {
        try {
            await provider.logout();
            res.json({ ok: true });
        } catch (err) {
            res.status(errorStatus(err)).json({ error: err.message });
        }
    }));

    router.post('/api/codex/chat/completions', wrapAsync(async (req, res) => {
        const request = req.body || {};
        if (!Array.isArray(request.messages) || request.messages.length === 0) {
            res.status(400).json({ error: 'messages must be a non-empty array' });
            return;
        }
        if (typeof request.model !== 'string' || !request.model) {
            res.status(400).json({ error: 'model must be a non-empty string' });
            return;
        }

        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) controller.abort();
        });

        if (request.stream) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();
            try {
                const result = await provider.complete(request, {
                    signal: controller.signal,
                    onTextDelta(delta) {
                        writeSse(res, {
                            id: 'codex-stream',
                            object: 'chat.completion.chunk',
                            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                        });
                    },
                    onReasoningDelta(delta) {
                        writeSse(res, {
                            id: 'codex-stream',
                            object: 'chat.completion.chunk',
                            choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
                        });
                    },
                });
                if (result.toolCall) {
                    writeSse(res, {
                        id: result.id,
                        object: 'chat.completion.chunk',
                        model: result.model,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: 0,
                                    id: result.toolCall.id,
                                    type: 'function',
                                    function: {
                                        name: result.toolCall.name,
                                        arguments: result.toolCall.arguments,
                                    },
                                }],
                            },
                            finish_reason: null,
                        }],
                    });
                }
                writeSse(res, {
                    id: result.id,
                    object: 'chat.completion.chunk',
                    model: result.model,
                    choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
                    usage: result.usage,
                });
                res.write('data: [DONE]\n\n');
                res.end();
            } catch (err) {
                if (controller.signal.aborted) return;
                writeSse(res, { error: { message: err.message, type: err.name || 'codex_error' } });
                res.end();
            }
            return;
        }

        try {
            const result = await provider.complete(request, { signal: controller.signal });
            res.json(openAIResponse(result));
        } catch (err) {
            if (controller.signal.aborted) return;
            res.status(errorStatus(err)).json({ error: err.message });
        }
    }));

    return router;
}

