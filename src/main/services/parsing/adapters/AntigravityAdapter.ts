/**
 * Google Antigravity adapter — structural foundation for Gemini-CLI–backed
 * sessions stored under `~/.gemini/antigravity-ide/`.
 *
 * This adapter is intentionally minimal: it implements detection and
 * system-context discovery, while leaving session-log parsing, metadata
 * extraction, and semantic-step extraction as safe structural placeholders.
 * Those placeholders are documented to describe the Gemini message-schema
 * mapping that will be filled in once the adapter graduates from foundation
 * to a fully-fledged provider.
 *
 * Antigravity directory layout (subject to change):
 *   ~/.gemini/antigravity-ide/
 *     conversations/   — per-session conversation logs (Gemini-CLI schema)
 *     brain/           — long-lived "brain" context files
 *     knowledge/       — knowledge-base entries
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import * as os from 'os';
import * as path from 'path';

import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';
import type { Session } from '@main/types/domain';
import type { IAgentProvider, SystemContextFiles } from '@main/types/providers';

/** Base directory for the Antigravity IDE data layout. */
const ANTIGRAVITY_BASE = path.join(os.homedir(), '.gemini', 'antigravity-ide');
const CONVERSATIONS_DIR = path.join(ANTIGRAVITY_BASE, 'conversations');
const BRAIN_DIR = path.join(ANTIGRAVITY_BASE, 'brain');
const KNOWLEDGE_DIR = path.join(ANTIGRAVITY_BASE, 'knowledge');

/**
 * Single-file descriptor stored under {@link SystemContextFiles.files}. Mirrors
 * the minimal shape consumed by the renderer's CLAUDE.md panel so the existing
 * UI can render Antigravity context with no further changes.
 */
interface AntigravityContextFile {
  /** Absolute path to the file on disk. */
  path: string;
  /** Logical category — `brain` or `knowledge`. */
  category: 'brain' | 'knowledge';
  /** Whether the file currently exists on disk. */
  exists: boolean;
  /** File size in bytes (best-effort). */
  size: number;
}

/**
 * Maps Gemini-CLI message roles onto the internal Claude-style assistant/user
 * vocabulary. Exported for tests and future parseSessionLog callers.
 */
export function mapGeminiRole(role: string): 'user' | 'assistant' | 'system' {
  switch (role) {
    case 'model':
      return 'assistant';
    case 'user':
      return 'user';
    default:
      return 'system';
  }
}

export class AntigravityAdapter implements IAgentProvider {
  readonly id = 'antigravity';
  readonly name = 'Google Antigravity';

  constructor(private projectScanner: ProjectScanner) {}

  /**
   * Returns true when the Antigravity conversations directory exists.
   * Falls back to a fresh {@link LocalFileSystemProvider} when the scanner
   * does not expose one (defensive — the scanner always provides one today).
   */
  async detectSession(_projectPath: string): Promise<boolean> {
    const fsProvider = this.getFsProvider();
    return fsProvider.exists(CONVERSATIONS_DIR);
  }

  /**
   * Structural placeholder. The eventual implementation will read the
   * Gemini-CLI JSON conversation file at {@link logFilePath}, normalise each
   * message via {@link mapGeminiRole}, and emit a {@link Session} consistent
   * with the existing Claude session domain model. For now we return a
   * minimally-populated Session derived from the log file path so callers can
   * reason about identity without crashing.
   */
  async parseSessionLog(logFilePath: string): Promise<Session> {
    const sessionId = path.basename(logFilePath, path.extname(logFilePath));
    const projectPath = ANTIGRAVITY_BASE;
    return {
      id: sessionId,
      projectId: this.id,
      projectPath,
      createdAt: 0,
      hasSubagents: false,
      messageCount: 0,
      metadataLevel: 'light',
    };
  }

  /**
   * Reads the `brain/` and `knowledge/` directories and returns a combined
   * {@link SystemContextFiles} map keyed by absolute path. Missing
   * directories are treated as empty rather than as errors so the adapter
   * remains usable on systems that have only one of them.
   */
  async parseSystemContext(_workspacePath: string): Promise<SystemContextFiles> {
    const fsProvider = this.getFsProvider();
    const files = new Map<string, unknown>();

    await this.collectContextFiles(fsProvider, BRAIN_DIR, 'brain', files);
    await this.collectContextFiles(fsProvider, KNOWLEDGE_DIR, 'knowledge', files);

    return { files };
  }

  /**
   * Placeholder for Gemini-specific metadata extraction (model name, token
   * usage, system instructions, ...). Returns `null` until the schema is
   * finalised.
   */
  extractMetadata(_logLines: unknown[]): unknown {
    return null;
  }

  /**
   * Placeholder for Gemini-specific semantic step extraction. Returns an
   * empty array until the schema is finalised.
   */
  extractSemanticSteps(_logLines: unknown[]): unknown[] {
    return [];
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private getFsProvider(): FileSystemProvider {
    const scannerProvider = this.projectScanner.getFileSystemProvider();
    return scannerProvider ?? new LocalFileSystemProvider();
  }

  private async collectContextFiles(
    fsProvider: FileSystemProvider,
    dir: string,
    category: AntigravityContextFile['category'],
    out: Map<string, unknown>
  ): Promise<void> {
    if (!(await fsProvider.exists(dir))) {
      return;
    }

    try {
      const entries = await fsProvider.readdir(dir);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const absolutePath = path.join(dir, entry.name);
        let size = entry.size ?? 0;
        if (size === 0) {
          try {
            const stat = await fsProvider.stat(absolutePath);
            size = stat.size;
          } catch {
            // Best-effort: leave size at 0 if stat fails.
          }
        }
        const descriptor: AntigravityContextFile = {
          path: absolutePath,
          category,
          exists: true,
          size,
        };
        out.set(absolutePath, descriptor);
      }
    } catch {
      // Directory unreadable — fall through with whatever has already been collected.
    }
  }
}
