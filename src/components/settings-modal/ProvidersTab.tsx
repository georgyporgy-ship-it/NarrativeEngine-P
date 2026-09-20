import { useEffect, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Loader2, CheckCircle, XCircle, ExternalLink, RefreshCw, LogOut } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { testConnection } from '../../services/chatEngine';
import type { LLMProvider, ApiFormat, ThinkingEffort, ComfyUiSettings } from '../../types';
import { detectFormatFromEndpoint } from '../../utils/llmApiHelper';
import { toast } from '../Toast';
import { uid } from '../../utils/uid';
import { codexApi, type CodexLogin, type CodexStatus } from '../../services/llm/codexApi';

const COMFY_DEFAULT_ENDPOINT = 'http://127.0.0.1:8188';
const OPENROUTER_DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1';

function getEndpointPlaceholder(apiFormat?: ApiFormat) {
    const fmt = apiFormat || 'openai';
    if (fmt === 'ollama') return 'http://localhost:11434  or  https://ollama.com';
    if (fmt === 'claude') return 'https://api.anthropic.com/v1';
    if (fmt === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta';
    if (fmt === 'comfyui') return COMFY_DEFAULT_ENDPOINT;
    if (fmt === 'openrouter') return OPENROUTER_DEFAULT_ENDPOINT;
    if (fmt === 'codex') return 'Managed by Codex app-server';
    return 'http://localhost:11434/v1';
}

function getApiKeyPlaceholder(apiFormat?: ApiFormat) {
    const fmt = apiFormat || 'openai';
    if (fmt === 'ollama') return 'Ollama API key (optional for local)';
    if (fmt === 'claude') return 'sk-ant-...';
    if (fmt === 'gemini') return 'AIza...';
    if (fmt === 'openrouter') return 'sk-or-v1-...';
    if (fmt === 'codex') return 'No API key required';
    return 'sk-...';
}

export function ProvidersTab() {
    const settings = useAppStore(s => s.settings);
    const addProvider = useAppStore(s => s.addProvider);
    const updateProvider = useAppStore(s => s.updateProvider);
    const removeProvider = useAppStore(s => s.removeProvider);

    const [activeTab, setActiveTab] = useState(settings.providers[0]?.id || '');
    const [isExpanded, setIsExpanded] = useState(true);
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
    const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
    const [codexLogin, setCodexLogin] = useState<CodexLogin | null>(null);
    const [codexLoading, setCodexLoading] = useState(false);

    const activeProvider = settings.providers.find(p => p.id === activeTab) || settings.providers[0];

    const refreshCodex = async () => {
        setCodexLoading(true);
        try {
            const status = await codexApi.status();
            setCodexStatus(status);
            if (status.authenticated) setCodexLogin(null);
            if (activeProvider?.apiFormat === 'codex' && status.models.length > 0) {
                const current = status.models.find(model => model.id === activeProvider.modelName);
                const selected = current || status.models.find(model => model.isDefault) || status.models[0];
                const efforts = selected.supportedReasoningEfforts;
                const effort = efforts.includes(activeProvider.codexReasoningEffort || '')
                    ? activeProvider.codexReasoningEffort
                    : selected.defaultReasoningEffort || efforts[0];
                updateProvider(activeProvider.id, {
                    modelName: selected.id,
                    codexReasoningEffort: effort || undefined,
                });
            }
        } catch (err) {
            setCodexStatus({
                installed: false,
                authenticated: false,
                email: null,
                planType: null,
                models: [],
                error: err instanceof Error ? err.message : 'Could not reach the Codex service',
            });
        } finally {
            setCodexLoading(false);
        }
    };

    useEffect(() => {
        if (activeProvider?.apiFormat !== 'codex') return;
        const timer = window.setTimeout(() => { void refreshCodex(); }, 0);
        return () => window.clearTimeout(timer);
        // Provider selection is the trigger. Model/effort updates inside refresh
        // must not recursively fetch the catalogue.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeProvider?.id, activeProvider?.apiFormat]);

    useEffect(() => {
        if (!codexLogin) return;
        const timer = window.setInterval(() => { void refreshCodex(); }, 2_000);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codexLogin?.loginId]);

    const handleAddProvider = () => {
        const newProvider: LLMProvider = {
            id: uid(),
            label: `Provider ${settings.providers.length + 1}`,
            endpoint: 'http://localhost:11434/v1',
            apiKey: '',
            modelName: '',
            apiFormat: 'openai',
            streamingEnabled: true,
        };
        addProvider(newProvider);
        setActiveTab(newProvider.id);
        setTestResult(null);
    };

    const handleRemoveProvider = (id: string) => {
        if (settings.providers.length <= 1) return;
        removeProvider(id);
        const remaining = settings.providers.filter(p => p.id !== id);
        setActiveTab(remaining[0]?.id || '');
        setTestResult(null);
    };

    const handleFieldChange = (field: keyof LLMProvider, value: string | boolean | undefined) => {
        if (!activeProvider) return;
        updateProvider(activeProvider.id, { [field]: value });
    };

    const handleOutputCeilingChange = (rawValue: string) => {
        if (!activeProvider) return;
        const trimmed = rawValue.trim();
        if (trimmed === "") {
            updateProvider(activeProvider.id, { maxOutputTokens: undefined });
            return;
        }
        const parsed = Number(trimmed);
        updateProvider(activeProvider.id, {
            maxOutputTokens: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
        });
    };

    const handleApiFormatChange = (newFormat: ApiFormat) => {
        if (!activeProvider) return;
        let endpoint = (activeProvider.endpoint || '').replace(/\/+$/, '');
        if (newFormat === 'ollama') {
            endpoint = endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        } else if (newFormat === 'openai' || newFormat === 'claude') {
            if (endpoint && !endpoint.endsWith('/v1') && /localhost:11434|127\.0\.0\.1:11434/.test(endpoint)) {
                endpoint = endpoint + '/v1';
            }
        } else if (newFormat === 'comfyui') {
            // Only auto-fill when the user hasn't set a real endpoint yet — i.e. it's
            // still the Ollama/default value. A custom endpoint is left untouched.
            if (!endpoint || /^https?:\/\/(localhost|127\.0\.0\.1):11434(\/v1)?$/.test(endpoint)) {
                endpoint = COMFY_DEFAULT_ENDPOINT;
            }
        } else if (newFormat === 'openrouter') {
            if (!endpoint || /^https?:\/\/(localhost|127\.0\.0\.1):11434(\/v1)?$/.test(endpoint)) {
                endpoint = OPENROUTER_DEFAULT_ENDPOINT;
            }
        } else if (newFormat === 'codex') {
            endpoint = 'codex://app-server';
        } else if (endpoint.startsWith('codex://')) {
            endpoint = 'http://localhost:11434/v1';
        }
        updateProvider(activeProvider.id, {
            apiFormat: newFormat,
            endpoint,
            ...(newFormat === 'codex' ? { apiKey: '', streamingEnabled: true } : {}),
        });
    };

    const handleComfyChange = (field: keyof ComfyUiSettings, value: string | number | undefined) => {
        if (!activeProvider) return;
        const nextComfy: ComfyUiSettings = { ...(activeProvider.comfyUi || {}), [field]: value };
        updateProvider(activeProvider.id, { comfyUi: nextComfy });
    };

    const handleComfyNumberChange = (field: keyof ComfyUiSettings, raw: string) => {
        const trimmed = raw.trim();
        if (trimmed === '') {
            handleComfyChange(field, undefined);
            return;
        }
        const n = Number(trimmed);
        handleComfyChange(field, Number.isFinite(n) ? n : undefined);
    };

    const handleEndpointBlur = (endpoint: string) => {
        if (!activeProvider || !endpoint) return;
        const detected = detectFormatFromEndpoint(endpoint);
        if (!detected) return;
        const currentFormat = activeProvider.apiFormat || 'openai';
        if (currentFormat === detected) return;
        let normalizedEndpoint = endpoint.replace(/\/+$/, '');
        if (detected === 'ollama') {
            normalizedEndpoint = normalizedEndpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        }
        updateProvider(activeProvider.id, { apiFormat: detected, endpoint: normalizedEndpoint });
    };

    const handleTest = async () => {
        if (!activeProvider || !activeProvider.endpoint) return;
        setIsTesting(true);
        setTestResult(null);
        const result = await testConnection(activeProvider);
        setTestResult(result);
        setIsTesting(false);
        if (result.ok) {
            toast.success('Connection successful');
        } else {
            toast.error(`Connection failed: ${result.detail}`);
        }
    };

    const canDelete = settings.providers.length > 1;
    const config = activeProvider;
    const isComfy = (config?.apiFormat || 'openai') === 'comfyui';
    const isOpenRouter = (config?.apiFormat || 'openai') === 'openrouter';
    const isCodex = (config?.apiFormat || 'openai') === 'codex';
    const selectedCodexModel = codexStatus?.models.find(model => model.id === config?.modelName);

    return (
        <div data-ui="providers" className="flex flex-col">
            <div data-ui="provider-list" className="flex flex-col mb-6">
                <label className="text-text-dim text-xs uppercase tracking-widest mb-2 font-bold">Providers</label>
                <div className="flex items-center gap-1 border-b border-border overflow-x-auto pb-px">
                    {settings.providers.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => { setActiveTab(p.id); setTestResult(null); }}
                            className={`px-3 py-2 text-[11px] uppercase tracking-wider whitespace-nowrap transition-all border-b-2 -mb-px ${activeTab === p.id
                                ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                                : 'text-text-dim border-transparent hover:text-text-primary hover:border-border'
                            }`}
                        >
                            {p.label || p.modelName || 'Provider'}
                        </button>
                    ))}
                    <button
                        onClick={handleAddProvider}
                        className="px-3 py-2 text-text-dim hover:text-terminal transition-colors -mb-px border-b-2 border-transparent"
                        title="Add Provider"
                    >
                        <Plus size={14} />
                    </button>
                </div>
            </div>

            {config && (
                <div data-ui="provider-config" className="mb-8">
                    <div className="border border-border rounded mb-3 bg-void-lighter overflow-hidden">
                        <button
                            onClick={() => setIsExpanded(!isExpanded)}
                            className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors"
                        >
                            <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
                                {isExpanded ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
                                {config.label || config.modelName || 'Provider'}
                            </div>
                        </button>

                        {isExpanded && (
                            /* Two columns once there is room for them. DOM order
                               already pairs up the way the layout wants —
                               Label|Endpoint, then Format full-width, then
                               Model|Key, then Streaming|Thinking — so nothing
                               is reordered here; the fields that need the full
                               row just declare `xl:col-span-2`. Without this a
                               full-stretch pane turns the API key into a
                               1900px-wide single-line input. */
                            <div className="p-4 border-t border-border bg-void grid grid-cols-1 xl:grid-cols-2 gap-x-6 gap-y-4 items-start">
                                <div>
                                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Label</label>
                                    <input
                                        type="text"
                                        value={config.label}
                                        onChange={(e) => handleFieldChange('label', e.target.value)}
                                        placeholder="My Provider"
                                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:border-terminal focus:outline-none"
                                    />
                                </div>
                                {isCodex && config && (
                                    <CodexAccountPanel
                                        status={codexStatus}
                                        login={codexLogin}
                                        loading={codexLoading}
                                        onRefresh={() => { void refreshCodex(); }}
                                        onLogin={async () => {
                                            setCodexLoading(true);
                                            try { setCodexLogin(await codexApi.login()); }
                                            catch (err) { toast.error(err instanceof Error ? err.message : 'Could not start ChatGPT sign-in'); }
                                            finally { setCodexLoading(false); }
                                        }}
                                        onLogout={async () => {
                                            setCodexLoading(true);
                                            try { await codexApi.logout(); setCodexLogin(null); await refreshCodex(); }
                                            catch (err) { toast.error(err instanceof Error ? err.message : 'Could not sign out'); }
                                            finally { setCodexLoading(false); }
                                        }}
                                    />
                                )}
                                {!isCodex && <div>
                                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Endpoint</label>
                                    <input
                                        type="text"
                                        value={config.endpoint}
                                        onChange={(e) => handleFieldChange('endpoint', e.target.value)}
                                        onBlur={(e) => handleEndpointBlur(e.target.value)}
                                        placeholder={getEndpointPlaceholder(config.apiFormat)}
                                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                                    />
                                    {(config.apiFormat || 'openai') === 'ollama' && (
                                        <p className="text-[10px] text-text-dim mt-1">
                                            Local: <span className="font-mono">http://localhost:11434</span> &middot; Cloud: <span className="font-mono">https://ollama.com</span> (needs API key)
                                        </p>
                                    )}
                                </div>}
                                <div className="xl:col-span-2">
                                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Format</label>
                                    <div data-ui="seg" className="flex border border-border overflow-hidden rounded">
                                        {(['openai', 'ollama', 'claude', 'gemini', 'codex', 'comfyui', 'openrouter'] as ApiFormat[]).map(fmt => (
                                            <button
                                                key={fmt}
                                                onClick={() => handleApiFormatChange(fmt)}
                                                className={`flex-1 px-2 py-2 text-[10px] uppercase tracking-wider transition-colors focus:outline-none ${(config.apiFormat || 'openai') === fmt
                                                    ? 'bg-terminal text-surface font-bold'
                                                    : 'bg-void text-text-dim hover:text-text-primary'
                                                }`}
                                            >
                                                {fmt === 'openai' ? 'OpenAI' : fmt === 'ollama' ? 'Ollama' : fmt === 'claude' ? 'Claude' : fmt === 'gemini' ? 'Gemini' : fmt === 'codex' ? 'ChatGPT / Codex' : fmt === 'comfyui' ? 'ComfyUI' : 'OpenRouter'}
                                            </button>
                                        ))}
                                    </div>
                                    {isOpenRouter && (
                                        <p className="text-[10px] text-text-dim mt-1">
                                            Use for OpenRouter <span className="font-mono">image</span> models — they live on <span className="font-mono">/api/v1/images</span>, not the OpenAI image route. For OpenRouter <em>text</em> models keep the OpenAI format.
                                        </p>
                                    )}
                                </div>
                                <div>
                                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">{isComfy ? 'Checkpoint Model Name' : 'Model Name'}</label>
                                    {isCodex ? (
                                        <select
                                            value={config.modelName}
                                            onChange={(e) => {
                                                const model = codexStatus?.models.find(item => item.id === e.target.value);
                                                handleFieldChange('modelName', e.target.value);
                                                updateProvider(config.id, {
                                                    codexReasoningEffort: model?.defaultReasoningEffort || model?.supportedReasoningEfforts[0] || undefined,
                                                });
                                            }}
                                            disabled={!codexStatus?.authenticated || !codexStatus.models.length}
                                            className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary font-mono focus:border-terminal focus:outline-none disabled:opacity-50"
                                        >
                                            {!codexStatus?.models.length && <option value={config.modelName}>{config.modelName || 'Sign in to load models'}</option>}
                                            {codexStatus?.models.map(model => (
                                                <option key={model.id} value={model.id}>{model.displayName} ({model.id})</option>
                                            ))}
                                        </select>
                                    ) : (
                                        <input
                                            type="text"
                                            value={config.modelName}
                                            onChange={(e) => handleFieldChange('modelName', e.target.value)}
                                            placeholder={isComfy ? 'sd_xl_base_1.0.safetensors' : isOpenRouter ? 'google/gemini-2.5-flash-image' : 'llama3'}
                                            className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                                        />
                                    )}
                                    {isComfy && (
                                        <p className="text-[10px] text-text-dim mt-1">Checkpoint filename as it appears in ComfyUI's <span className="font-mono">CheckpointLoaderSimple</span>. Used by the built-in graph; ignored if your custom workflow sets its own checkpoint.</p>
                                    )}
                                </div>
                                {isComfy && (
                                    <ComfyUiFields
                                        comfy={config.comfyUi || {}}
                                        onTextChange={handleComfyChange}
                                        onNumberChange={handleComfyNumberChange}
                                    />
                                )}
                                {!isComfy && !isCodex && (
                                    <div>
                                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Key</label>
                                        <input
                                            type="password"
                                            value={config.apiKey}
                                            onChange={(e) => handleFieldChange('apiKey', e.target.value)}
                                            placeholder={getApiKeyPlaceholder(config.apiFormat)}
                                            className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                                        />
                                    </div>
                                )}
                                {!isComfy && !isCodex && (
                                    <div className="flex items-center justify-between gap-3 py-2">
                                        <label className="text-[11px] text-text-dim uppercase tracking-wider truncate">Enable Streaming</label>
                                        <button
                                            onClick={() => handleFieldChange('streamingEnabled', config.streamingEnabled === false)}
                                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${config.streamingEnabled !== false ? 'bg-terminal/60' : 'bg-border'}`}
                                            title={config.streamingEnabled !== false ? 'Streaming on — click to disable' : 'Streaming off — click to enable'}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${config.streamingEnabled !== false ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                )}
                                {!isComfy && !isCodex && (
                                    <div>
                                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1" title="Requests reasoning from the model when supported. 'Max' maps to xhigh on OpenAI, max on DeepSeek V4, HIGH on Gemini.">
                                            Thinking effort
                                        </label>
                                        <div data-ui="seg" className="flex border border-border overflow-hidden rounded">
                                            {(['off', 'low', 'medium', 'high', 'max'] as ThinkingEffort[]).map(level => (
                                                <button
                                                    key={level}
                                                    onClick={() => handleFieldChange('thinkingEffort', level === 'off' ? undefined : level)}
                                                    className={`flex-1 px-2 py-1.5 text-[9px] uppercase tracking-wider transition-colors focus:outline-none ${(config.thinkingEffort === level) || (!config.thinkingEffort && level === 'off')
                                                        ? 'bg-terminal text-void font-bold'
                                                        : 'bg-void text-text-dim hover:text-text-primary'
                                                    }`}
                                                    title={level === 'max' ? 'OpenAI & DeepSeek cap at High — Max sends High.' : undefined}
                                                >
                                                    {level.charAt(0).toUpperCase() + level.slice(1)}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {isCodex && (
                                    <div>
                                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Thinking effort</label>
                                        <div data-ui="seg" className="flex border border-border overflow-hidden rounded">
                                            {(selectedCodexModel?.supportedReasoningEfforts || []).map(level => (
                                                <button
                                                    key={level}
                                                    onClick={() => handleFieldChange('codexReasoningEffort', level)}
                                                    className={`flex-1 px-2 py-1.5 text-[9px] uppercase tracking-wider transition-colors focus:outline-none ${config.codexReasoningEffort === level
                                                        ? 'bg-terminal text-void font-bold'
                                                        : 'bg-void text-text-dim hover:text-text-primary'
                                                    }`}
                                                >
                                                    {level}
                                                </button>
                                            ))}
                                        </div>
                                        {!selectedCodexModel?.supportedReasoningEfforts.length && (
                                            <p className="text-[10px] text-text-dim mt-1">The selected model did not advertise configurable reasoning levels.</p>
                                        )}
                                    </div>
                                )}
                                {!isComfy && !isCodex && (
                                    <div>
                                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">
                                            Output ceiling
                                        </label>
                                        <input
                                            type="number"
                                            min={1}
                                            step={1}
                                            value={config.maxOutputTokens ?? ""}
                                            onChange={(e) => handleOutputCeilingChange(e.target.value)}
                                            placeholder="Leave blank if unsure"
                                            className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                                        />
                                        <p className="text-[10px] text-text-dim mt-1 leading-relaxed">
                                            Maximum tokens this endpoint can return in one response  -  <strong>not its context window</strong>. Leave blank if unsure; the app stays conservative when reasoning is enabled.
                                        </p>
                                    </div>
                                )}
                                <div data-ui="provider-actions" className="pt-2 xl:col-span-2 grid grid-cols-1 xl:grid-cols-2 gap-x-6 gap-y-3 items-start">
                                  <div>
                                    <button
                                        onClick={handleTest}
                                        disabled={isTesting || !config.endpoint}
                                        className="w-full bg-surface border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest py-2 transition-all hover:glow-border disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {isTesting ? <><Loader2 size={14} className="animate-spin" /> Testing...</> : 'Test Connection'}
                                    </button>
                                    {testResult && (
                                        <div className={`flex items-center gap-2 text-xs px-3 py-2 border mt-2 ${testResult.ok ? 'border-terminal/30 text-terminal bg-terminal/5' : 'border-danger/30 text-danger bg-danger/5'}`}>
                                            {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                                            {testResult.detail}
                                        </div>
                                    )}
                                  </div>
                                  <div>
                                    <button
                                        onClick={() => handleRemoveProvider(config.id)}
                                        disabled={!canDelete}
                                        className="w-full bg-void border border-danger/40 text-danger text-xs uppercase tracking-widest py-2 transition-all hover:bg-danger/10 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                    >
                                        <Trash2 size={14} /> Delete Provider
                                    </button>
                                    {!canDelete && (
                                        <p className="text-[10px] text-text-dim mt-1 text-center">Cannot delete the last provider</p>
                                    )}
                                  </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function CodexAccountPanel({
    status,
    login,
    loading,
    onRefresh,
    onLogin,
    onLogout,
}: {
    status: CodexStatus | null;
    login: CodexLogin | null;
    loading: boolean;
    onRefresh: () => void;
    onLogin: () => void;
    onLogout: () => void;
}) {
    const statusText = !status
        ? 'Checking Codex...'
        : !status.installed
            ? 'Codex CLI is not installed or not on PATH'
            : status.authenticated
                ? `Signed in${status.email ? ` as ${status.email}` : ''}${status.planType ? ` (${status.planType})` : ''}`
                : 'Not signed in with ChatGPT';

    return (
        <div className="xl:col-span-1 border border-terminal/20 bg-terminal/5 rounded px-3 py-3">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <div className="text-[11px] text-terminal uppercase tracking-wider font-bold">ChatGPT / Codex OAuth</div>
                    <div className="text-xs text-text-primary mt-1">{statusText}</div>
                </div>
                {loading && <Loader2 size={16} className="animate-spin text-terminal shrink-0" />}
            </div>
            {status?.error && <p className="text-[10px] text-danger mt-2">{status.error}</p>}
            <p className="text-[10px] text-text-dim mt-2 leading-relaxed">
                Authentication, token refresh, and credentials are managed by the official Codex CLI. Narrative Engine never reads the Codex credential file.
            </p>
            {login && (
                <div className="mt-3 border border-border bg-void px-3 py-2 text-xs">
                    <div className="text-text-dim">Open the sign-in page and enter this code:</div>
                    <div className="font-mono text-terminal text-base tracking-widest my-2 select-all">{login.userCode}</div>
                    <a
                        href={login.verificationUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-terminal hover:underline"
                    >
                        Open ChatGPT sign-in <ExternalLink size={12} />
                    </a>
                </div>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
                {!status?.authenticated && (
                    <button
                        onClick={onLogin}
                        disabled={loading || status?.installed === false}
                        className="bg-terminal text-void text-[10px] uppercase tracking-wider font-bold px-3 py-2 disabled:opacity-40"
                    >
                        Sign in with ChatGPT
                    </button>
                )}
                {status?.authenticated && (
                    <button
                        onClick={onLogout}
                        disabled={loading}
                        className="inline-flex items-center gap-1 bg-void border border-border text-text-dim text-[10px] uppercase tracking-wider px-3 py-2 disabled:opacity-40"
                    >
                        <LogOut size={12} /> Sign out
                    </button>
                )}
                <button
                    onClick={onRefresh}
                    disabled={loading || status?.installed === false}
                    className="inline-flex items-center gap-1 bg-void border border-border text-text-dim text-[10px] uppercase tracking-wider px-3 py-2 disabled:opacity-40"
                >
                    <RefreshCw size={12} /> Refresh
                </button>
            </div>
        </div>
    );
}

const COMFY_PLACEHOLDERS = '%prompt%, %negative_prompt%, %seed%, %width%, %height%, %steps%, %cfg%, %sampler%, %scheduler%, %denoise%, %model%';

function ComfyUiFields({
    comfy,
    onTextChange,
    onNumberChange,
}: {
    comfy: ComfyUiSettings;
    onTextChange: (field: keyof ComfyUiSettings, value: string | undefined) => void;
    onNumberChange: (field: keyof ComfyUiSettings, raw: string) => void;
}) {
    return (
        <>
            {/* Rendered as grid items of the provider form above — the workflow
                editor and the info banner want the whole row, the numeric knobs
                tile across it. */}
            <div className="xl:col-span-2 border border-terminal/20 bg-terminal/5 rounded px-3 py-2">
                <p className="text-[10px] text-text-dim leading-relaxed">
                    <span className="text-terminal font-bold uppercase tracking-wider">Image Generation AI only.</span>{' '}
                    Point this at a local ComfyUI server. Leave the workflow blank to use the built-in basic txt2img graph, or paste a workflow exported from ComfyUI via <span className="font-mono">Save (API Format)</span>.
                </p>
            </div>

            <div className="xl:col-span-2">
                <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Custom API Workflow JSON</label>
                <textarea
                    value={comfy.customWorkflowJson || ''}
                    onChange={(e) => onTextChange('customWorkflowJson', e.target.value || undefined)}
                    rows={6}
                    placeholder='Blank = built-in basic txt2img. Paste a "Save (API Format)" export here to use your own graph.'
                    className="w-full bg-surface border border-border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none resize-y"
                />
                <p className="text-[10px] text-text-dim mt-1 leading-relaxed">
                    Supported placeholders (substituted before the graph runs):<br />
                    <span className="font-mono text-text-primary/80">{COMFY_PLACEHOLDERS}</span>
                </p>
            </div>

            <div className="xl:col-span-2 grid grid-cols-2 xl:grid-cols-5 gap-3">
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Steps</label>
                    <input
                        type="number"
                        value={comfy.steps ?? ''}
                        onChange={(e) => onNumberChange('steps', e.target.value)}
                        placeholder="20"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">CFG Scale</label>
                    <input
                        type="number"
                        step="0.1"
                        value={comfy.cfgScale ?? ''}
                        onChange={(e) => onNumberChange('cfgScale', e.target.value)}
                        placeholder="7"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Sampler</label>
                    <input
                        type="text"
                        value={comfy.sampler ?? ''}
                        onChange={(e) => onTextChange('sampler', e.target.value || undefined)}
                        placeholder="euler"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Scheduler</label>
                    <input
                        type="text"
                        value={comfy.scheduler ?? ''}
                        onChange={(e) => onTextChange('scheduler', e.target.value || undefined)}
                        placeholder="normal"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Denoise</label>
                    <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        value={comfy.denoisingStrength ?? ''}
                        onChange={(e) => onNumberChange('denoisingStrength', e.target.value)}
                        placeholder="1"
                        className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                    />
                </div>
            </div>
        </>
    );
}
