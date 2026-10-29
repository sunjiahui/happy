/**
 * Machine-local model discovery for mobile clients.
 *
 * Catalogs travel through the existing encrypted machine RPC. The Relay never
 * sees their plaintext and no provider credentials leave this process.
 */

import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { extractConfigOptionsFromPayload, extractModelStateFromPayload } from '@/agent/acp/sessionConfigMetadata';
import type { AgentMessage } from '@/agent/core';
import { DefaultTransport } from '@/agent/transport';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';

const CACHE_TTL_MS = 5 * 60_000;
const MAX_MODELS = 500;
const MAX_OPTIONS = 50;

export const ListAgentModelsRequestSchema = z.object({
    agent: z.enum(['codex', 'claude', 'kiro']),
    forceRefresh: z.boolean().optional(),
    workingDirectory: z.string().min(1).max(4096).optional(),
}).strict();

export type ListAgentModelsRequest = z.infer<typeof ListAgentModelsRequestSchema>;
export type AgentModelCatalogErrorCode =
    | 'UNSUPPORTED_AGENT'
    | 'CLI_UNAVAILABLE'
    | 'PROVIDER_AUTH'
    | 'PROVIDER_TIMEOUT'
    | 'MALFORMED_RESPONSE'
    | 'EMPTY_CATALOG'
    | 'PROBE_UNAVAILABLE';

export type AgentModelCatalog = {
    agent: ListAgentModelsRequest['agent'];
    source: 'provider' | 'stable-aliases';
    fetchedAt: number;
    models: Array<{
        id: string;
        name: string;
        description?: string | null;
        isDefault?: boolean;
    }>;
    effort?: {
        selectorId: string;
        options: Array<{ id: string; name: string }>;
        defaultOptionId?: string | null;
    } | null;
};

export type AgentModelCatalogResult =
    | { ok: true; catalog: AgentModelCatalog }
    | { ok: false; error: { code: AgentModelCatalogErrorCode; retryable: boolean } };

type CacheEntry = { expiresAt: number; catalog: AgentModelCatalog };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<AgentModelCatalogResult>>();

function cleanText(value: unknown, maxBytes: number): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (!cleaned || Buffer.byteLength(cleaned, 'utf8') > maxBytes) return null;
    return cleaned;
}
function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readOptionRows(value: unknown): Array<{ id: string; name: string; description?: string | null }> {
    if (!Array.isArray(value)) return [];
    const rows: Array<{ id: string; name: string; description?: string | null }> = [];
    const visit = (entry: unknown): void => {
        const record = asRecord(entry);
        if (!record) return;
        if (Array.isArray(record.options)) {
            for (const child of record.options) visit(child);
            return;
        }
        const id = cleanText(record.value ?? record.id ?? record.modelId, 256);
        const name = cleanText(record.name ?? record.displayName ?? id, 256);
        if (!id || !name) return;
        const description = cleanText(record.description, 2048);
        rows.push({ id, name, ...(description ? { description } : {}) });
    };
    for (const entry of value) visit(entry);
    return rows;
}

export function normalizeCodexModels(rows: unknown[]): AgentModelCatalog['models'] {
    const models: AgentModelCatalog['models'] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const record = asRecord(row);
        if (!record) continue;
        const id = cleanText(record.id ?? record.model ?? record.slug, 256);
        const name = cleanText(record.name ?? record.displayName ?? record.display_name ?? id, 256);
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        const description = cleanText(record.description, 2048);
        const isDefault = record.isDefault === true || record.is_default === true;
        models.push({ id, name, ...(description ? { description } : {}), ...(isDefault ? { isDefault: true } : {}) });
        if (models.length > MAX_MODELS) throw new Error('model catalog exceeds limit');
    }
    return models;
}

async function discoverCodex(): Promise<AgentModelCatalog> {
    const client = new CodexAppServerClient();
    await client.connect();
    try {
        const models = normalizeCodexModels(await client.listModels());
        if (models.length === 0) throw new Error('empty model catalog');
        return { agent: 'codex', source: 'provider', fetchedAt: Date.now(), models };
    } finally {
        await client.disconnect();
    }
}

function discoverClaude(): AgentModelCatalog {
    return {
        agent: 'claude',
        source: 'stable-aliases',
        fetchedAt: Date.now(),
        models: [
            { id: 'default', name: 'Default', isDefault: true },
            { id: 'fable', name: 'Fable' },
            { id: 'opus', name: 'Opus' },
            { id: 'sonnet', name: 'Sonnet' },
            { id: 'haiku', name: 'Haiku' },
        ],
    };
}

async function validatedKiroDirectory(input: string | undefined): Promise<string> {
    if (!input) throw new Error('Kiro model discovery requires a project directory');
    const absolute = resolve(input);
    const info = await stat(absolute);
    if (!info.isDirectory()) throw new Error('Kiro project path is not a directory');
    return await realpath(absolute);
}

async function discoverKiro(workingDirectory: string): Promise<AgentModelCatalog> {
    let models: AgentModelCatalog['models'] = [];
    let effort: AgentModelCatalog['effort'] = null;
    const backend = new AcpBackend({
        agentName: 'kiro',
        cwd: workingDirectory,
        command: 'kiro-cli',
        args: ['acp'],
        transportHandler: new DefaultTransport('kiro'),
    });

    backend.onMessage((message: AgentMessage) => {
        if (message.type !== 'event') return;
        if (message.name === 'config_options_update') {
            const options = extractConfigOptionsFromPayload(message.payload) ?? [];
            for (const option of options) {
                if (option.type !== 'select') continue;
                const rows = readOptionRows(option.options);
                if (option.category === 'model') {
                    models = rows.slice(0, MAX_MODELS).map((row) => ({
                        id: row.id,
                        name: row.name,
                        ...(row.description ? { description: row.description } : {}),
                        ...(row.id === option.currentValue ? { isDefault: true } : {}),
                    }));
                }
                if (option.category === 'thought_level') {
                    effort = {
                        selectorId: option.id,
                        options: rows.slice(0, MAX_OPTIONS).map((row) => ({ id: row.id, name: row.name })),
                        defaultOptionId: option.currentValue,
                    };
                }
            }
        }
        if (message.name === 'models_update' && models.length === 0) {
            const state = extractModelStateFromPayload(message.payload);
            if (state) {
                models = readOptionRows(state.availableModels).slice(0, MAX_MODELS).map((row) => ({
                    id: row.id,
                    name: row.name,
                    ...(row.description ? { description: row.description } : {}),
                    ...(row.id === state.currentModelId ? { isDefault: true } : {}),
                }));
            }
        }
    });

    try {
        await backend.startSession();
        if (models.length === 0) throw new Error('Kiro ACP did not publish a model catalog');
        return { agent: 'kiro', source: 'provider', fetchedAt: Date.now(), models, effort };
    } finally {
        await backend.dispose();
    }
}

function classifyFailure(error: unknown, agent: ListAgentModelsRequest['agent']): AgentModelCatalogResult {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('enoent') || message.includes('not found') || message.includes('required')) {
        return { ok: false, error: { code: 'CLI_UNAVAILABLE', retryable: true } };
    }
    if (message.includes('auth') || message.includes('login') || message.includes('credential')) {
        return { ok: false, error: { code: 'PROVIDER_AUTH', retryable: false } };
    }
    if (message.includes('timeout') || message.includes('timed out')) {
        return { ok: false, error: { code: 'PROVIDER_TIMEOUT', retryable: true } };
    }
    if (message.includes('empty')) {
        return { ok: false, error: { code: 'EMPTY_CATALOG', retryable: true } };
    }
    if (agent === 'kiro' && message.includes('did not publish')) {
        return { ok: false, error: { code: 'PROBE_UNAVAILABLE', retryable: false } };
    }
    return { ok: false, error: { code: 'MALFORMED_RESPONSE', retryable: true } };
}

async function discover(request: ListAgentModelsRequest, kiroDirectory: string | null): Promise<AgentModelCatalogResult> {
    try {
        const catalog = request.agent === 'codex'
            ? await discoverCodex()
            : request.agent === 'claude'
                ? discoverClaude()
                : await discoverKiro(kiroDirectory!);
        return { ok: true, catalog };
    } catch (error) {
        return classifyFailure(error, request.agent);
    }
}

export async function listAgentModels(input: unknown): Promise<AgentModelCatalogResult> {
    const parsed = ListAgentModelsRequestSchema.safeParse(input);
    if (!parsed.success) {
        return { ok: false, error: { code: 'UNSUPPORTED_AGENT', retryable: false } };
    }

    let kiroDirectory: string | null = null;
    if (parsed.data.agent === 'kiro') {
        try {
            kiroDirectory = await validatedKiroDirectory(parsed.data.workingDirectory);
        } catch (error) {
            return classifyFailure(error, 'kiro');
        }
    }
    const key = `${parsed.data.agent}:${kiroDirectory ?? ''}`;
    const running = inFlight.get(key);
    if (running) return await running;

    const cached = cache.get(key);
    if (!parsed.data.forceRefresh && cached && cached.expiresAt > Date.now()) {
        return { ok: true, catalog: cached.catalog };
    }

    const pending = discover(parsed.data, kiroDirectory).then((result) => {
        if (result.ok && result.catalog.models.length > 0) {
            cache.set(key, { catalog: result.catalog, expiresAt: Date.now() + CACHE_TTL_MS });
        }
        return result;
    }).finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return await pending;
}
