/**
 * Kiro ACP Backend - Kiro CLI agent via ACP
 *
 * This module provides a factory function for creating a Kiro backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Kiro CLI (kiro-cli) is Amazon's AI coding assistant that supports
 * ACP mode via the `kiro-cli acp` command.
 *
 * Install: curl -fsSL https://cli.kiro.dev/install | bash
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { kiroTransport } from '../transport';
import { logger } from '@/ui/logger';

/**
 * Options for creating a Kiro ACP backend
 */
export interface KiroBackendOptions extends AgentFactoryOptions {
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating a Kiro backend
 */
export interface KiroBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
}

/**
 * Create a Kiro backend using ACP.
 *
 * The Kiro CLI must be installed and available in PATH as `kiro-cli`.
 * Uses the `acp` subcommand to enable ACP mode.
 *
 * Install Kiro CLI: curl -fsSL https://cli.kiro.dev/install | bash
 *
 * @param options - Configuration options
 * @returns KiroBackendResult with the created backend
 */
export function createKiroBackend(options: KiroBackendOptions): KiroBackendResult {
  const backendOptions: AcpBackendOptions = {
    agentName: 'kiro',
    cwd: options.cwd,
    command: 'kiro-cli',
    args: ['acp'],
    env: {
      ...options.env,
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: kiroTransport,
  };

  logger.debug('[Kiro] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: new AcpBackend(backendOptions),
  };
}

/**
 * Register Kiro backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Kiro agent available for use.
 */
export function registerKiroAgent(): void {
  agentRegistry.register('kiro', (opts) => createKiroBackend(opts).backend);
  logger.debug('[Kiro] Registered with agent registry');
}
