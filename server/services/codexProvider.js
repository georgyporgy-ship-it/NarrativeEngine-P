import { EventEmitter } from 'node:events';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;
export const CODEX_THREAD_SANDBOX = 'read-only';
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_THREAD_INSTRUCTION = [
    'Act only as the language model for the supplied roleplay conversation.',
    'Do not inspect files, run commands, use built-in tools, browse, or rely on prior thread history.',
    'Use only the supplied messages and the explicitly declared host tools.',
].join(' ');

export class CodexError extends Error {}
export class CodexUnavailableError extends CodexError {}
export class CodexAuthenticationError extends CodexError {}
export class CodexProtocolError extends CodexError {}
export class CodexTimeoutError extends CodexError {}
export class CodexTransportError extends CodexError {}

function executableCandidates(binary) {
    if (binary.includes(path.sep) || (path.sep === '\\' && binary.includes('/'))) return [binary];
    const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    return (process.env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap(dir => suffixes.map(suffix => path.join(dir, `${binary}${suffix}`)));
}

export function isExecutableAvailable(binary) {
    return executableCandidates(binary).some(candidate => {
        try {
            accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
}

function errorMessage(error) {
    if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
    return String(error || 'Unknown Codex error');
}

export class CodexAppServer extends EventEmitter {
    constructor({ binary = process.env.CODEX_BINARY || 'codex', spawnImpl = spawn } = {}) {
        super();
        this.binary = binary;
        this.spawnImpl = spawnImpl;
        this.process = null;
        this.pending = new Map();
        this.nextId = 0;
        this.startPromise = null;
        this.stderrLines = [];
        this.generation = 0;
    }

    get installed() {
        return isExecutableAvailable(this.binary);
    }

    async start() {
        if (this.process && this.process.exitCode === null && !this.process.killed) return;
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.#startOnce();
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async #startOnce() {
        if (!this.installed) {
            throw new CodexUnavailableError('Codex CLI was not found. Install it or set CODEX_BINARY to its executable path.');
        }
        await this.stop();
        const child = this.spawnImpl(this.binary, ['app-server', '--listen', 'stdio://'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.process = child;
        this.generation += 1;
        const generation = this.generation;
        this.stderrLines = [];

        child.once('error', err => this.#transportFailed(new CodexUnavailableError(`Could not start Codex app-server: ${errorMessage(err)}`), generation));
        child.once('exit', (code, signal) => {
            const tail = this.stderrTail();
            const detail = tail ? `: ${tail}` : ` (code=${code ?? 'null'}, signal=${signal ?? 'none'})`;
            this.#transportFailed(new CodexTransportError(`Codex app-server exited${detail}`), generation);
        });

        const lines = readline.createInterface({ input: child.stdout });
        lines.on('line', line => this.#onLine(line, generation));
        child.stderr.on('data', chunk => {
            const text = String(chunk);
            for (const line of text.split(/\r?\n/).filter(Boolean)) {
                this.stderrLines.push(line);
                if (this.stderrLines.length > 80) this.stderrLines.shift();
            }
        });

        try {
            await this.request('initialize', {
                clientInfo: {
                    name: 'narrative-engine',
                    title: 'Narrative Engine',
                    version: '2.0.0',
                },
                capabilities: { experimentalApi: true },
            }, { timeoutMs: STARTUP_TIMEOUT_MS, ensureStarted: false });
            this.notify('initialized', {}, { ensureStarted: false });
        } catch (err) {
            await this.stop();
            throw err;
        }
    }

    #onLine(rawLine, generation) {
        if (generation !== this.generation) return;
        const line = rawLine.trim();
        if (!line) return;
        let message;
        try {
            message = JSON.parse(line);
        } catch (err) {
            this.#failPending(new CodexProtocolError(`Malformed app-server JSON: ${errorMessage(err)}`));
            return;
        }
        if (!message || typeof message !== 'object') return;

        // Server-initiated JSON-RPC requests carry both an id and a method.
        if (message.id !== undefined && typeof message.method === 'string') {
            const respond = result => this.#write({ id: message.id, result }, false);
            const reject = (code, detail) => this.#write({
                id: message.id,
                error: { code, message: detail },
            }, false);
            this.emit('serverRequest', message, { respond, reject });
            return;
        }

        if (message.id !== undefined) {
            const pending = this.pending.get(String(message.id));
            if (pending) {
                this.pending.delete(String(message.id));
                clearTimeout(pending.timer);
                if (message.error) {
                    const detail = typeof message.error === 'object'
                        ? message.error.message || JSON.stringify(message.error)
                        : String(message.error);
                    pending.reject(new CodexProtocolError(`${pending.method} failed: ${detail}`));
                } else {
                    const result = message.result;
                    if (result !== undefined && (result === null || typeof result !== 'object')) {
                        pending.reject(new CodexProtocolError(`${pending.method} returned a non-object result`));
                    } else {
                        pending.resolve(result || {});
                    }
                }
            }
            return;
        }

        if (typeof message.method === 'string') this.emit('notification', message);
    }

    #write(message, ensureStarted = true) {
        if (ensureStarted && (!this.process || this.process.exitCode !== null)) {
            throw new CodexTransportError('Codex app-server is not running');
        }
        const child = this.process;
        if (!child || child.exitCode !== null || !child.stdin?.writable) {
            throw new CodexTransportError('Codex app-server is not running');
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    async request(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS, ensureStarted = true } = {}) {
        if (ensureStarted) await this.start();
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(String(id));
                reject(new CodexTimeoutError(`Timed out waiting for ${method}`));
            }, timeoutMs);
            this.pending.set(String(id), { resolve, reject, timer, method });
            try {
                this.#write({ id, method, ...(params !== undefined ? { params } : {}) }, false);
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(String(id));
                reject(err);
            }
        });
    }

    notify(method, params, { ensureStarted = true } = {}) {
        this.#write({ method, ...(params !== undefined ? { params } : {}) }, ensureStarted);
    }

    stderrTail() {
        return this.stderrLines.slice(-4).join(' | ');
    }

    #failPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    #transportFailed(error, generation) {
        if (generation !== this.generation) return;
        this.process = null;
        this.generation += 1;
        this.#failPending(error);
        this.emit('transportError', error);
    }

    async stop() {
        const child = this.process;
        this.process = null;
        this.generation += 1;
        this.#failPending(new CodexTransportError('Codex app-server stopped'));
        if (!child || child.exitCode !== null) return;
        try { child.stdin?.end(); } catch { /* already closed */ }
        child.kill();
    }

    async restart() {
        await this.stop();
        await this.start();
    }
}

function modelId(entry) {
    const value = entry?.model || entry?.id;
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeCodexModel(entry) {
    const id = modelId(entry);
    if (!id || entry?.hidden === true) return null;
    const efforts = [];
    for (const item of entry.supportedReasoningEfforts || []) {
        const effort = typeof item === 'string' ? item : item?.reasoningEffort;
        if (typeof effort === 'string' && effort && !efforts.includes(effort)) efforts.push(effort);
    }
    return {
        id,
        displayName: entry.displayName || id,
        supportedReasoningEfforts: efforts,
        defaultReasoningEffort: entry.defaultReasoningEffort || null,
        inputModalities: Array.isArray(entry.inputModalities) ? entry.inputModalities : ['text', 'image'],
        isDefault: entry.isDefault === true,
    };
}

function textContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => {
        if (typeof part === 'string') return part;
        return typeof part?.text === 'string' ? part.text : '';
    }).filter(Boolean).join('\n');
}

export function responseItems(messages) {
    const items = [];
    for (const message of messages || []) {
        const originalRole = String(message?.role || 'user');
        if (originalRole === 'tool') {
            items.push({
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: `Tool result${message.tool_call_id ? ` for ${message.tool_call_id}` : ''}:\n${textContent(message.content)}`,
                }],
            });
            continue;
        }
        let role = originalRole === 'system' ? 'developer' : originalRole;
        if (!['developer', 'user', 'assistant'].includes(role)) role = 'user';
        let text = textContent(message.content);
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            const calls = message.tool_calls.map(call => ({
                id: call?.id,
                name: call?.function?.name,
                arguments: call?.function?.arguments,
            }));
            text = `${text ? `${text}\n\n` : ''}Host tool request:\n${JSON.stringify(calls)}`;
        }
        if (!text) continue;
        items.push({
            type: 'message',
            role,
            content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
        });
    }
    return items;
}

export function dynamicToolsFromOpenAI(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.flatMap(tool => {
        const fn = tool?.type === 'function' ? tool.function : null;
        if (!fn || typeof fn.name !== 'string' || !fn.name) return [];
        return [{
            name: fn.name,
            description: typeof fn.description === 'string' ? fn.description : '',
            inputSchema: fn.parameters && typeof fn.parameters === 'object'
                ? fn.parameters
                : { type: 'object', properties: {} },
        }];
    });
}

function usageFromEvent(params) {
    const usage = params?.tokenUsage || params?.usage || {};
    const total = usage?.totalTokenUsage && typeof usage.totalTokenUsage === 'object'
        ? usage.totalTokenUsage
        : usage;
    const prompt = Number(total?.inputTokens ?? total?.promptTokens ?? 0) || 0;
    const completion = Number(total?.outputTokens ?? total?.completionTokens ?? 0) || 0;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: Number(total?.totalTokens) || prompt + completion,
        prompt_tokens_details: { cached_tokens: Number(total?.cachedInputTokens ?? total?.cachedTokens ?? 0) || 0 },
        completion_tokens_details: { reasoning_tokens: Number(total?.reasoningOutputTokens ?? total?.reasoningTokens ?? 0) || 0 },
    };
}

function nearestEffort(requested, model) {
    const supported = model.supportedReasoningEfforts || [];
    if (!supported.length) return requested || model.defaultReasoningEffort || undefined;
    if (supported.includes(requested)) return requested;
    if (!requested && supported.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
    const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const target = Math.max(0, order.indexOf(requested || model.defaultReasoningEffort || 'medium'));
    return [...supported].sort((a, b) => {
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        return Math.abs((ai < 0 ? 99 : ai) - target) - Math.abs((bi < 0 ? 99 : bi) - target);
    })[0];
}

export class CodexProvider {
    constructor({ rpc = new CodexAppServer() } = {}) {
        this.rpc = rpc;
        this.callTail = Promise.resolve();
    }

    async account() {
        const result = await this.rpc.request('account/read', { refreshToken: false }, { timeoutMs: 30_000 });
        const account = result.account;
        if (!account || typeof account !== 'object') return { authenticated: false, email: null, planType: null };
        return {
            authenticated: account.type === 'chatgpt',
            email: account.email || null,
            planType: account.planType || null,
        };
    }

    async status({ includeModels = true } = {}) {
        const base = {
            installed: this.rpc.installed,
            authenticated: false,
            email: null,
            planType: null,
            models: [],
            error: null,
        };
        if (!base.installed) {
            base.error = 'Codex CLI was not found on PATH';
            return base;
        }
        try {
            const account = await this.account();
            Object.assign(base, account);
            if (base.authenticated && includeModels) base.models = await this.listModels();
        } catch (err) {
            base.error = errorMessage(err);
        }
        return base;
    }

    async beginDeviceLogin() {
        const result = await this.rpc.request('account/login/start', { type: 'chatgptDeviceCode' }, { timeoutMs: 30_000 });
        if (typeof result.verificationUrl !== 'string' || !result.verificationUrl.startsWith('https://') || typeof result.userCode !== 'string') {
            throw new CodexProtocolError('Codex did not return a valid device login URL and code');
        }
        return {
            loginId: result.loginId || null,
            verificationUrl: result.verificationUrl,
            userCode: result.userCode,
        };
    }

    async logout() {
        await this.rpc.request('account/logout', undefined, { timeoutMs: 30_000 });
    }

    async listModels() {
        const models = [];
        const seen = new Set();
        let cursor = null;
        do {
            const result = await this.rpc.request('model/list', {
                limit: 100,
                includeHidden: false,
                ...(cursor ? { cursor } : {}),
            }, { timeoutMs: 30_000 });
            if (!Array.isArray(result.data)) throw new CodexProtocolError('model/list returned a malformed catalogue');
            for (const raw of result.data) {
                const model = normalizeCodexModel(raw);
                if (model && !seen.has(model.id)) {
                    seen.add(model.id);
                    models.push(model);
                }
            }
            cursor = result.nextCursor || null;
        } while (cursor);
        if (!models.length) throw new CodexProtocolError('No visible Codex models are available for this account');
        return models;
    }

    async complete(request, callbacks = {}) {
        const run = () => this.#completeOnce(request, callbacks);
        const operation = this.callTail.then(run, run);
        this.callTail = operation.catch(() => undefined);
        return operation;
    }

    async #completeOnce(request, callbacks) {
        if (callbacks.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const account = await this.account();
        if (!account.authenticated) {
            throw new CodexAuthenticationError('ChatGPT is not signed in through Codex. Open Settings and sign in.');
        }
        const models = await this.listModels();
        const selected = models.find(model => model.id === request.model)
            || models.find(model => model.isDefault)
            || models[0];
        const effort = nearestEffort(request.reasoning_effort, selected);
        const cwd = await mkdtemp(path.join(os.tmpdir(), 'narrative-codex-'));
        let threadId = null;
        let turnId = null;
        let toolCall = null;
        let usage = usageFromEvent({});
        let fullText = '';
        let reasoning = '';
        let resolveTurn;
        let rejectTurn;
        let turnTimer;
        const turnDone = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
        const dynamicTools = dynamicToolsFromOpenAI(request.tools);

        const onNotification = message => {
            const params = message.params || {};
            if (params.threadId && threadId && params.threadId !== threadId) return;
            if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
                fullText += params.delta;
                callbacks.onTextDelta?.(params.delta);
            } else if ((message.method === 'item/reasoning/summaryTextDelta' || message.method === 'item/reasoning/textDelta') && typeof params.delta === 'string') {
                reasoning += params.delta;
                callbacks.onReasoningDelta?.(params.delta);
            } else if (message.method === 'thread/tokenUsage/updated') {
                usage = usageFromEvent(params);
            } else if (message.method === 'item/completed') {
                const item = params.item || {};
                if (item.type === 'agentMessage' && typeof item.text === 'string' && !fullText) fullText = item.text;
            } else if (message.method === 'turn/completed') {
                const turn = params.turn || {};
                if (!turnId || !turn.id || turn.id === turnId) resolveTurn(turn);
            }
        };

        const onServerRequest = (message, responder) => {
            const params = message.params || {};
            if (params.threadId && threadId && params.threadId !== threadId) return;
            if (message.method !== 'item/tool/call') {
                responder.reject(-32601, 'Narrative Engine does not allow interactive Codex requests or built-in tools');
                return;
            }
            const name = typeof params.tool === 'string' ? params.tool : params.tool?.name;
            toolCall = {
                id: params.itemId || params.callId || `call_${Date.now()}`,
                name: name || 'unknown_tool',
                arguments: typeof params.arguments === 'string'
                    ? params.arguments
                    : JSON.stringify(params.arguments || {}),
            };
            responder.respond({
                contentItems: [{ type: 'inputText', text: 'Execution is delegated to the Narrative Engine host.' }],
                success: true,
            });
            if (threadId && turnId) {
                this.rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5_000 })
                    .catch(() => undefined);
            }
        };

        const onTransportError = err => rejectTurn(err);
        this.rpc.on('notification', onNotification);
        this.rpc.on('serverRequest', onServerRequest);
        this.rpc.on('transportError', onTransportError);

        let abortHandler;
        if (callbacks.signal) {
            abortHandler = () => {
                if (threadId && turnId) {
                    this.rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5_000 })
                        .catch(() => undefined);
                }
            };
            callbacks.signal.addEventListener('abort', abortHandler, { once: true });
        }

        try {
            const threadResult = await this.rpc.request('thread/start', {
                model: selected.id,
                cwd,
                approvalPolicy: 'never',
                sandbox: CODEX_THREAD_SANDBOX,
                serviceName: 'narrative-engine',
                ...(dynamicTools.length ? { dynamicTools } : {}),
            }, { timeoutMs: 30_000 });
            threadId = threadResult.thread?.id;
            if (typeof threadId !== 'string' || !threadId) throw new CodexProtocolError('thread/start returned no thread id');

            const messages = Array.isArray(request.messages) ? [...request.messages] : [];
            const finalMessage = messages.at(-1)?.role === 'user' ? messages.pop() : null;
            const injected = responseItems([
                { role: 'system', content: REQUEST_THREAD_INSTRUCTION },
                ...messages,
            ]);
            if (injected.length) {
                await this.rpc.request('thread/inject_items', { threadId, items: injected }, { timeoutMs: 30_000 });
            }

            const turnResult = await this.rpc.request('turn/start', {
                threadId,
                input: [{
                    type: 'text',
                    text: textContent(finalMessage?.content) || 'Continue from the supplied conversation.',
                }],
                model: selected.id,
                approvalPolicy: 'never',
                sandboxPolicy: {
                    type: 'readOnly',
                    access: {
                        type: 'restricted',
                        includePlatformDefaults: true,
                        readableRoots: [cwd],
                    },
                },
                ...(effort ? { effort } : {}),
            }, { timeoutMs: 30_000 });
            turnId = turnResult.turn?.id;
            if (typeof turnId !== 'string' || !turnId) throw new CodexProtocolError('turn/start returned no turn id');

            const timeoutMs = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
                ? request.timeoutMs
                : DEFAULT_TIMEOUT_MS;
            const timeout = new Promise((_, reject) => {
                turnTimer = setTimeout(
                    () => reject(new CodexTimeoutError('Timed out waiting for Codex turn completion')),
                    timeoutMs,
                );
            });
            const completed = await Promise.race([turnDone, timeout]);
            if (callbacks.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (!toolCall && completed?.status && completed.status !== 'completed') {
                const detail = completed.error?.message || completed.error || completed.status;
                throw new CodexProtocolError(`Codex turn ended with status ${completed.status}: ${detail}`);
            }
            if (!toolCall && !fullText.trim()) throw new CodexProtocolError('Codex turn completed without an agent message');
            return {
                id: turnId,
                model: selected.id,
                content: fullText,
                reasoning,
                toolCall,
                usage,
                finishReason: toolCall ? 'tool_calls' : 'stop',
            };
        } finally {
            if (turnTimer) clearTimeout(turnTimer);
            this.rpc.off('notification', onNotification);
            this.rpc.off('serverRequest', onServerRequest);
            this.rpc.off('transportError', onTransportError);
            if (callbacks.signal && abortHandler) callbacks.signal.removeEventListener('abort', abortHandler);
            if (threadId) {
                await this.rpc.request('thread/delete', { threadId }, { timeoutMs: 5_000 }).catch(() => undefined);
            }
            await rm(cwd, { recursive: true, force: true });
        }
    }
}

let singleton;

export function getCodexProvider() {
    if (!singleton) singleton = new CodexProvider();
    return singleton;
}
