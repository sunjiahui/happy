/**
 * Kiro Transport Handler
 *
 * Kiro CLI-specific implementation of TransportHandler.
 * Kiro CLI supports ACP (Agent Client Protocol) via `kiro-cli acp`,
 * communicating over stdin/stdout with JSON-RPC 2.0.
 *
 * @module KiroTransport
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from '../TransportHandler';

/**
 * Kiro-specific timeout values (in milliseconds)
 */
export const KIRO_TIMEOUTS = {
  /** Kiro CLI init timeout */
  init: 60_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Kiro CLI transport handler.
 *
 * Kiro CLI speaks standard ACP over stdin/stdout, so most defaults
 * from DefaultTransport apply. This handler customises timeouts and
 * suppresses non-JSON stderr noise produced by the Kiro CLI process.
 */
export class KiroTransport implements TransportHandler {
  readonly agentName = 'kiro';

  /**
   * Kiro CLI initialisation timeout.
   */
  getInitTimeout(): number {
    return KIRO_TIMEOUTS.init;
  }

  /**
   * Filter Kiro CLI stdout: only pass through valid JSON-RPC lines.
   *
   * Kiro CLI may emit non-JSON startup messages to stdout; we discard
   * those to avoid breaking the ACP JSON-RPC parser.
   */
  filterStdoutLine(line: string): string | null {
    const trimmed = line.trim();

    if (!trimmed) {
      return null;
    }

    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      return line;
    } catch {
      return null;
    }
  }

  /**
   * Handle Kiro CLI stderr output.
   *
   * Suppresses routine startup/info messages; surfaces errors as
   * status messages when appropriate.
   */
  handleStderr(text: string, _context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }
    return { message: null };
  }

  /**
   * Kiro CLI uses standard ACP tool names — no special patterns needed.
   */
  getToolPatterns(): ToolPattern[] {
    return [];
  }

  /**
   * Get timeout for a tool call.
   */
  getToolCallTimeout(_toolCallId: string, _toolKind?: string): number {
    return KIRO_TIMEOUTS.toolCall;
  }

  /**
   * Get idle detection timeout.
   */
  getIdleTimeout(): number {
    return KIRO_TIMEOUTS.idle;
  }

  /**
   * Tool names are already standard in Kiro CLI; no extraction needed.
   */
  extractToolNameFromId(_toolCallId: string): string | null {
    return null;
  }

  /**
   * Kiro CLI sends well-formed tool names; pass them through unchanged.
   */
  determineToolName(
    toolName: string,
    _toolCallId: string,
    _input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    return toolName;
  }
}

/**
 * Singleton instance for convenience.
 */
export const kiroTransport = new KiroTransport();
