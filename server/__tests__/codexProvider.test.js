import { describe, expect, it } from 'vitest';
import {
    CODEX_THREAD_SANDBOX,
    dynamicToolsFromOpenAI,
    normalizeCodexModel,
    responseItems,
} from '../services/codexProvider.js';

describe('Codex provider adapters', () => {
    it('uses the app-server sandbox spelling required by thread/start', () => {
        expect(CODEX_THREAD_SANDBOX).toBe('read-only');
    });

    it('normalizes account-visible models and their exact effort catalogue', () => {
        expect(normalizeCodexModel({
            model: 'gpt-test',
            displayName: 'GPT Test',
            supportedReasoningEfforts: [
                { reasoningEffort: 'minimal' },
                { reasoningEffort: 'xhigh' },
            ],
            defaultReasoningEffort: 'minimal',
            inputModalities: ['text'],
            isDefault: true,
        })).toEqual({
            id: 'gpt-test',
            displayName: 'GPT Test',
            supportedReasoningEfforts: ['minimal', 'xhigh'],
            defaultReasoningEffort: 'minimal',
            inputModalities: ['text'],
            isDefault: true,
        });
    });

    it('maps OpenAI functions to app-server dynamic tools', () => {
        expect(dynamicToolsFromOpenAI([{
            type: 'function',
            function: {
                name: 'search_archive',
                description: 'Search campaign memory',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                },
            },
        }])).toEqual([{
            name: 'search_archive',
            description: 'Search campaign memory',
            inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
            },
        }]);
    });

    it('preserves tool-loop history without exposing files or hidden threads', () => {
        const items = responseItems([
            { role: 'system', content: 'Be the GM.' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', function: { name: 'search_archive', arguments: '{"query":"gate"}' } }],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'The gate was sealed.' },
        ]);
        expect(items[0]).toMatchObject({ role: 'developer' });
        expect(items[1].content[0].text).toContain('search_archive');
        expect(items[2].content[0].text).toContain('The gate was sealed.');
    });
});

