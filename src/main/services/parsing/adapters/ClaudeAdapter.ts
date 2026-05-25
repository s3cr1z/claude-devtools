/**
 * Claude Code adapter — wraps the existing Claude session/CLAUDE.md discovery
 * pipeline in the provider-agnostic {@link IAgentProvider} contract.
 *
 * This adapter is intentionally thin: it delegates to the existing
 * `SessionParser`, `readAllClaudeMdFiles`, `ProjectScanner` and JSONL helpers
 * that already power Claude support. The goal is to introduce the adapter
 * surface without changing any Claude-specific behaviour.
 *
 * `parseSessionLog`, `extractMetadata` and `extractSemanticSteps` are
 * intentional placeholders for the moment: the production paths still flow
 * through {@link ProjectScanner}'s legacy mapping logic. Once that mapping is
 * consolidated into an adapter-friendly shape those methods will start
 * delegating to {@link SessionParser} and the helpers in `@main/utils/jsonl`.
 */

import { readAllClaudeMdFiles } from '../ClaudeMdReader';

import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { Session } from '@main/types/domain';
import type { IAgentProvider, SystemContextFiles } from '@main/types/providers';

export class ClaudeAdapter implements IAgentProvider {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';

  constructor(private projectScanner: ProjectScanner) {}

  /**
   * Detects whether a Claude Code projects directory exists on disk.
   * Mirrors the legacy detection performed by `ProjectScanner.scan`.
   */
  async detectSession(_projectPath: string): Promise<boolean> {
    const fsProvider = this.projectScanner.getFileSystemProvider();
    const projectsDir = this.projectScanner.getProjectsDir();
    return fsProvider.exists(projectsDir);
  }

  /**
   * Placeholder: the production path still goes through ProjectScanner's
   * Session-to-ParsedSession mapping. Once that mapping is consolidated into
   * an adapter-friendly shape this method will delegate to `SessionParser`.
   */
  async parseSessionLog(_logFilePath: string): Promise<Session> {
    throw new Error('Delegated to ProjectScanner mapping logic temporarily.');
  }

  /**
   * Reads all CLAUDE.md locations for a workspace and returns them in the
   * provider-agnostic {@link SystemContextFiles} shape.
   */
  async parseSystemContext(workspacePath: string): Promise<SystemContextFiles> {
    const result = await readAllClaudeMdFiles(
      workspacePath,
      this.projectScanner.getFileSystemProvider()
    );
    return { files: result.files };
  }

  /**
   * Placeholder for Claude-specific metadata extraction. Returning `null`
   * preserves current behaviour while making the contract explicit.
   */
  extractMetadata(_logLines: unknown[]): unknown {
    return null;
  }

  /**
   * Placeholder for Claude-specific semantic-step extraction.
   */
  extractSemanticSteps(_logLines: unknown[]): unknown[] {
    return [];
  }
}
