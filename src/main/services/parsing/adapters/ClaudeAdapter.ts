/**
 * ClaudeAdapter — implements IAgentProvider for Claude Code sessions.
 *
 * Wraps the existing Claude-specific services (SessionParser, ClaudeMdReader,
 * ProjectScanner) so the rest of the application can interact with Claude
 * sessions through the provider-agnostic IAgentProvider interface.
 */

import { analyzeSessionFileMetadata } from '@main/utils/jsonl';
import { encodePath } from '@main/utils/pathDecoder';

import { readAllClaudeMdFiles } from '../ClaudeMdReader';
import { SessionParser } from '../SessionParser';

import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { Session } from '@main/types/domain';
import type { IAgentProvider, SystemContextFiles } from '@main/types/providers';

// Re-export the wrapped Claude services from this module so future iterations
// can delegate to them without touching imports elsewhere. The Session-to-
// ParsedSession mapping currently lives inside ProjectScanner and will be
// migrated here in a follow-up.
export { analyzeSessionFileMetadata, SessionParser };

export class ClaudeAdapter implements IAgentProvider {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';

  constructor(private projectScanner: ProjectScanner) {}

  /**
   * Detect whether Claude Code has any sessions for the given workspace.
   * Claude stores sessions under `~/.claude/projects/<encoded-workspace>/`,
   * so detection needs to match the specific workspace rather than merely
   * checking whether the global Claude root exists.
   */
  async detectSession(projectPath: string): Promise<boolean> {
    const fsProvider = this.projectScanner.getFileSystemProvider();
    const projectsDir = this.projectScanner.getProjectsDir();
    return fsProvider.exists(`${projectsDir}/${encodePath(projectPath)}`);
  }

  /**
   * Parse a session log file into the application's Session model.
   *
   * The full Session-to-ParsedSession mapping currently lives inside
   * {@link ProjectScanner}; until that logic is extracted we throw so callers
   * don't silently end up with a partial object.
   */
  async parseSessionLog(_logFilePath: string): Promise<Session> {
    throw new Error('Delegated to ProjectScanner mapping logic temporarily.');
  }

  /**
   * Read Claude's system context files (CLAUDE.md and friends) for the
   * provided workspace path.
   */
  async parseSystemContext(workspacePath: string): Promise<SystemContextFiles> {
    const fsProvider = this.projectScanner.getFileSystemProvider();
    const result = await readAllClaudeMdFiles(workspacePath, fsProvider);
    return { files: result.files };
  }

  /**
   * Extract Claude-specific metadata from a list of log lines.
   * Placeholder — returns null until the corresponding logic is migrated
   * out of the existing parsing pipeline.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IAgentProvider contract uses `any` to stay provider-agnostic; per-provider log shapes differ.
  extractMetadata(_logLines: any[]): any {
    return null;
  }

  /**
   * Extract semantic steps from a list of log lines.
   * Placeholder — returns an empty array until the corresponding logic is
   * migrated out of the existing semantic-step pipeline.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IAgentProvider contract uses `any` to stay provider-agnostic; per-provider log shapes differ.
  extractSemanticSteps(_logLines: any[]): any[] {
    return [];
  }
}
