import { describe, expect, it } from 'vitest';
import { ListAgentModelsRequestSchema, normalizeCodexModels } from './agentModelCatalog';

describe('agent model catalog', () => {
    it('accepts only closed agent requests and bounded Kiro context', () => {
        expect(ListAgentModelsRequestSchema.safeParse({ agent: 'codex' }).success).toBe(true);
        expect(ListAgentModelsRequestSchema.safeParse({ agent: 'kiro', workingDirectory: '/project' }).success).toBe(true);
        expect(ListAgentModelsRequestSchema.safeParse({ agent: 'shell', command: 'sh' }).success).toBe(false);
        expect(ListAgentModelsRequestSchema.safeParse({ agent: 'codex', command: 'sh' }).success).toBe(false);
    });

    it('normalizes Codex rows in first-seen order and removes unsafe rows', () => {
        expect(normalizeCodexModels([
            { id: 'gpt-6-sol', displayName: 'GPT-6 Sol', description: 'Fast', isDefault: true },
            { id: 'gpt-6-sol', displayName: 'Duplicate' },
            { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna' },
            { id: '', name: 'bad' },
        ])).toEqual([
            { id: 'gpt-6-sol', name: 'GPT-6 Sol', description: 'Fast', isDefault: true },
            { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
        ]);
    });
});
