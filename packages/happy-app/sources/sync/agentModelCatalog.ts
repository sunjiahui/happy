import { apiSocket } from './apiSocket';

export type CatalogAgent = 'codex' | 'claude' | 'kiro';
export type MachineAgentModelCatalog = {
    agent: CatalogAgent;
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

export type MachineAgentModelCatalogResult =
    | { ok: true; catalog: MachineAgentModelCatalog }
    | { ok: false; error: { code: string; retryable: boolean } };

function isCatalogAgent(agent: string): agent is CatalogAgent {
    return agent === 'codex' || agent === 'claude' || agent === 'kiro';
}

/** Requests a plaintext catalog only after machine-key encryption is applied. */
export async function loadAgentModelCatalog(input: {
    machineId: string;
    agent: string;
    workingDirectory?: string;
    forceRefresh?: boolean;
}): Promise<MachineAgentModelCatalogResult | null> {
    if (!isCatalogAgent(input.agent)) return null;
    return await apiSocket.machineRPC<MachineAgentModelCatalogResult, {
        agent: CatalogAgent;
        workingDirectory?: string;
        forceRefresh?: boolean;
    }>(input.machineId, 'list-agent-models', {
        agent: input.agent,
        ...(input.agent === 'kiro' && input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
        ...(input.forceRefresh ? { forceRefresh: true } : {}),
    });
}
