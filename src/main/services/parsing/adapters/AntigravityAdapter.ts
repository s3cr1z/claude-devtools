/**
 * AntigravityAdapter — implements IAgentProvider for Google Antigravity (Gemini CLI) sessions.
 *
 * Wraps Google Antigravity session detection and system-context reading so the
 * rest of the application can interact with Antigravity sessions through the
 * provider-agnostic IAgentProvider interface.
 */

import * as os from 'os';
import * as path from 'path';

import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { Session } from '@main/types/domain';
import type { IAgentProvider, SystemContextFiles } from '@main/types/providers';

export class AntigravityAdapter implements IAgentProvider {
  readonly id = 'antigravity';
  readonly name = 'Google Antigravity';

  constructor(private projectScanner: ProjectScanner) {}

  /**
   * Detect whether Google Antigravity has any sessions for the given workspace.
   * Checks for the existence of the Antigravity conversations directory.
   */
  async detectSession(_projectPath: string): Promise<boolean> {
    const fsProvider = this.projectScanner.getFileSystemProvider();
    const conversationsDir = path.join(
      os.homedir(),
      '.gemini',
      'antigravity-ide',
      'conversations',
    );
    return fsProvider.exists(conversationsDir);
  }

  /**
   * Parse an Antigravity session log file into the application's Session model.
   *
   * Gemini role mapping has not yet been implemented; throws an error so callers
   * don't silently end up with a partial object.
   */
  async parseSessionLog(_logFilePath: string): Promise<Session> {
    throw new Error('Gemini role mapping not yet implemented.');
  }

  /**
   * Read Antigravity system context files (brain/ and knowledge/ directories)
   * for the provided workspace path.
   */
  async parseSystemContext(workspacePath: string): Promise<SystemContextFiles> {
    const fsProvider = this.projectScanner.getFileSystemProvider();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Map values are provider-specific; kept open so each provider can supply its own shape.
    const files = new Map<string, any>();

    const contextDirs = ['brain', 'knowledge'];
    for (const dir of contextDirs) {
      const dirPath = path.join(workspacePath, dir);
      if (await fsProvider.exists(dirPath)) {
        const entries = await fsProvider.readdir(dirPath);
        for (const entry of entries) {
          if (entry.isFile()) {
            const filePath = path.join(dirPath, entry.name);
            const content = await fsProvider.readFile(filePath, 'utf-8');
            files.set(filePath, { path: filePath, content, source: dir });
          }
        }
      }
    }

    return { files };
  }

  /**
   * Extract Antigravity-specific metadata from a list of log lines.
   * Placeholder — returns null until the corresponding logic is implemented.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IAgentProvider contract uses `any` to stay provider-agnostic; per-provider log shapes differ.
  extractMetadata(_logLines: any[]): any {
    return null;
  }

  /**
   * Extract semantic steps from a list of log lines.
   * Placeholder — returns an empty array until the corresponding logic is implemented.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IAgentProvider contract uses `any` to stay provider-agnostic; per-provider log shapes differ.
  extractSemanticSteps(_logLines: any[]): any[] {
    return [];
  }
}
