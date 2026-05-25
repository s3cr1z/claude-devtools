/**
 * Provider interface contract for AI model adapters.
 *
 * Each adapter (Claude Code, Google Antigravity, etc.) implements
 * {@link IAgentProvider} so the rest of the application can interact with
 * a heterogeneous set of agent runtimes through a single uniform surface.
 *
 * This module intentionally holds only structural type definitions — no
 * runtime dependencies — so it can be imported from anywhere in the main
 * process without creating circular references.
 */

import type { Session } from './domain';

/**
 * Aggregated token consumption for a session or request.
 *
 * Cache-related fields are optional because not every provider distinguishes
 * cache reads from cache creation (e.g. Claude reports both, Antigravity does
 * not). Consumers should treat missing fields as zero.
 */
export interface TokenMetrics {
  /** Input/prompt tokens consumed. */
  input: number;
  /** Output/completion tokens produced. */
  output: number;
  /** Tokens served from prompt cache (provider-specific). */
  cacheRead?: number;
  /** Tokens written to prompt cache (provider-specific). */
  cacheCreation?: number;
  /** Total tokens (input + output + cache, provider-defined sum). */
  total: number;
}

/**
 * Provider-agnostic container for system/context configuration files
 * (e.g. CLAUDE.md, GEMINI.md, brain/, knowledge/).
 *
 * The map keys are provider-defined identifiers (e.g. "enterprise", "user",
 * "project") and the values are provider-specific structures. Using `unknown`
 * forces consumers to narrow the type when reading.
 */
export interface SystemContextFiles {
  /** Map of context-file identifiers to provider-specific metadata. */
  files: Map<string, unknown>;
}

/**
 * Common contract implemented by every agent runtime adapter.
 *
 * Adapters wrap provider-specific session discovery and parsing logic behind
 * a uniform surface so higher-level services (registry, IPC handlers, UI)
 * can remain provider-agnostic.
 */
export interface IAgentProvider {
  /** Stable identifier (e.g. "claude-code", "antigravity"). */
  id: string;
  /** Human-readable display name. */
  name: string;

  /**
   * Detects whether this provider has any sessions for the given workspace.
   * @param projectPath - Absolute filesystem path of the workspace.
   * @returns `true` when the provider's data layout is present on disk.
   */
  detectSession(projectPath: string): Promise<boolean>;

  /**
   * Parses a single session log file into the shared {@link Session} domain
   * model. Adapters are responsible for mapping their provider-specific log
   * schema onto the common type.
   */
  parseSessionLog(logFilePath: string): Promise<Session>;

  /**
   * Reads provider-specific system/context configuration for a workspace.
   */
  parseSystemContext(workspacePath: string): Promise<SystemContextFiles>;

  /**
   * Extracts provider-specific session metadata from raw log lines.
   * Return shape is intentionally `unknown` until each adapter formalises
   * its metadata schema.
   */
  extractMetadata(logLines: unknown[]): unknown;

  /**
   * Extracts provider-specific semantic steps from raw log lines.
   * Return shape is intentionally `unknown[]` until each adapter formalises
   * its semantic-step schema.
   */
  extractSemanticSteps(logLines: unknown[]): unknown[];
}
