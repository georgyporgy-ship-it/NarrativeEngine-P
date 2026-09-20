import { API_BASE } from '../../lib/apiBase';

export type CodexModel = {
    id: string;
    displayName: string;
    supportedReasoningEfforts: string[];
    defaultReasoningEffort: string | null;
    inputModalities: string[];
    isDefault: boolean;
};

export type CodexStatus = {
    installed: boolean;
    authenticated: boolean;
    email: string | null;
    planType: string | null;
    models: CodexModel[];
    error: string | null;
};

export type CodexLogin = {
    loginId: string | null;
    verificationUrl: string;
    userCode: string;
};

async function parse<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Codex request failed (${response.status})`);
    return body as T;
}

export const codexApi = {
    async status(): Promise<CodexStatus> {
        return parse<CodexStatus>(await fetch(`${API_BASE}/codex/status`));
    },

    async login(): Promise<CodexLogin> {
        return parse<CodexLogin>(await fetch(`${API_BASE}/codex/login`, { method: 'POST' }));
    },

    async logout(): Promise<void> {
        await parse(await fetch(`${API_BASE}/codex/logout`, { method: 'POST' }));
    },
};

