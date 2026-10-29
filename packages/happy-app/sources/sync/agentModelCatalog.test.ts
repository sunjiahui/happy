import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC } = vi.hoisted(() => ({ machineRPC: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));

import { loadAgentModelCatalog } from './agentModelCatalog';

describe('machine agent model catalog', () => {
    beforeEach(() => machineRPC.mockReset());

    it('uses the encrypted machine RPC and scopes Kiro to the selected directory', async () => {
        machineRPC.mockResolvedValue({ ok: false, error: { code: 'PROBE_UNAVAILABLE', retryable: false } });
        await loadAgentModelCatalog({ machineId: 'm1', agent: 'kiro', workingDirectory: '/repo' });
        expect(machineRPC).toHaveBeenCalledWith('m1', 'list-agent-models', {
            agent: 'kiro',
            workingDirectory: '/repo',
        });
    });

    it('does not send arbitrary agent names to the machine', async () => {
        expect(await loadAgentModelCatalog({ machineId: 'm1', agent: 'shell' })).toBeNull();
        expect(machineRPC).not.toHaveBeenCalled();
    });
});
