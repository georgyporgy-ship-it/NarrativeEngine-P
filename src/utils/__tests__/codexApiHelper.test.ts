import { describe, expect, it } from 'vitest';
import type { EndpointConfig } from '../../types';
import { buildChatBody, buildChatHeaders, getChatUrl, getModelsUrl } from '../llmApiHelper';

const provider: EndpointConfig = {
    endpoint: 'codex://app-server',
    apiKey: '',
    modelName: 'gpt-test',
    apiFormat: 'codex',
    codexReasoningEffort: 'xhigh',
};

describe('Codex API helper routing', () => {
    it('uses local backend routes and never builds an authorization header', () => {
        expect(getChatUrl(provider)).toBe('/api/codex/chat/completions');
        expect(getModelsUrl(provider)).toBe('/api/codex/models');
        expect(buildChatHeaders(provider)).toEqual({ 'Content-Type': 'application/json' });
    });

    it('preserves the exact app-server reasoning effort and host tools', () => {
        const tools = [{ type: 'function', function: { name: 'search_archive', description: '', parameters: { type: 'object' } } }];
        expect(buildChatBody(provider, [{ role: 'user', content: 'Continue.' }], { tools })).toMatchObject({
            model: 'gpt-test',
            reasoning_effort: 'xhigh',
            tools,
        });
    });
});

