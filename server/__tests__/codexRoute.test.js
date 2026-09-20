import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createCodexRouter } from '../routes/codex.js';

function appWith(provider) {
    const app = express();
    app.use(express.json());
    app.use(createCodexRouter({ provider }));
    return app;
}

function result(overrides = {}) {
    return {
        id: 'turn_1',
        model: 'gpt-test',
        content: 'The torch gutters.',
        reasoning: '',
        toolCall: null,
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        finishReason: 'stop',
        ...overrides,
    };
}

describe('Codex routes', () => {
    it('returns status and starts device login without exposing credentials', async () => {
        const provider = {
            status: vi.fn().mockResolvedValue({ installed: true, authenticated: true, models: [{ id: 'gpt-test' }], error: null }),
            beginDeviceLogin: vi.fn().mockResolvedValue({ loginId: 'login_1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD' }),
        };
        const app = appWith(provider);

        const status = await request(app).get('/api/codex/status').expect(200);
        expect(status.body.models[0].id).toBe('gpt-test');

        const login = await request(app).post('/api/codex/login').expect(200);
        expect(login.body).toEqual({ loginId: 'login_1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD' });
    });

    it('normalizes non-streaming completions to the existing OpenAI contract', async () => {
        const provider = { complete: vi.fn().mockResolvedValue(result()) };
        const response = await request(appWith(provider))
            .post('/api/codex/chat/completions')
            .send({ model: 'gpt-test', messages: [{ role: 'user', content: 'Continue.' }] })
            .expect(200);

        expect(response.body.choices[0]).toMatchObject({
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'The torch gutters.' },
        });
    });

    it('streams text and host tool calls using OpenAI-compatible SSE', async () => {
        const provider = {
            complete: vi.fn(async (_body, callbacks) => {
                callbacks.onTextDelta?.('Checking memory...');
                return result({
                    content: 'Checking memory...',
                    toolCall: { id: 'call_1', name: 'search_archive', arguments: '{"query":"gate"}' },
                    finishReason: 'tool_calls',
                });
            }),
        };
        const response = await request(appWith(provider))
            .post('/api/codex/chat/completions')
            .send({ stream: true, model: 'gpt-test', messages: [{ role: 'user', content: 'Recall the gate.' }] })
            .expect(200);

        expect(response.text).toContain('Checking memory...');
        expect(response.text).toContain('search_archive');
        expect(response.text).toContain('tool_calls');
        expect(response.text).toContain('data: [DONE]');
    });

    it('returns an HTTP error when a streaming request fails before its first event', async () => {
        const provider = {
            complete: vi.fn().mockRejectedValue(new Error('ChatGPT is not signed in through Codex')),
        };
        const response = await request(appWith(provider))
            .post('/api/codex/chat/completions')
            .send({ stream: true, model: 'gpt-test', messages: [{ role: 'user', content: 'Continue.' }] })
            .expect(401);

        expect(response.body.error).toContain('not signed in');
    });
});
