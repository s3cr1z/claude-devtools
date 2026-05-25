/**
 * Provider interface contract for AI model adapters.
 *
 * Defines the abstraction that every AI agent provider (Claude Code,
 * Antigravity, etc.) must implement so the core application can stay
 * decoupled from any single model's specifics.
 */

import type { Session } from './domain';

/**
 * Token usage metrics emitted by a provider.
 *
 * Cache-related fields are optional because not every provider distinguishes
 * cache reads from cache creation; consumers should treat missing values as 0.
 */
export interface TokenMetrics {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  total: number;
}

/**
 * Provider-agnostic system context files (e.g. CLAUDE.md, AGENTS.md, etc.).
 */
export interface SystemContextFiles {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Map values are provider-specific (Claude uses ClaudeMdFileInfo); kept open so each provider can supply its own shape.
  files: Map<string, any>;
}

/**
 * Contract that all AI agent providers must implement.
 */
export interface IAgentProvider {
  id: string;
  name: string;

  /** Determine whether this provider has a session in the given workspace. */
  detectSession(projectPath: string): Promise<boolean>;

  /** Parse a session log file into the application's Session model. */
  parseSessionLog(logFilePath: string): Promise<Session>;

  /** Read the provider's system context files for a workspace. */
  parseSystemContext(workspacePath: string): Promise<SystemContextFiles>;

  /** Extract provider-specific metadata from a list of log lines. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Log line shape differs per provider; intentionally untyped at the interface boundary.
  extractMetadata(logLines: any[]): any;

  /** Extract semantic steps from a list of log lines. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Log line shape differs per provider; intentionally untyped at the interface boundary.
  extractSemanticSteps(logLines: any[]): any[];
}
