/**
 * OpenCodeAdapter — implements IAgentProvider for OpenCode sessions.
 *
 * OpenCode stores session state under its data directory in
 * `storage/project`, `storage/session`, `storage/message`, and the related
 * per-session task data directories.
 * This adapter matches a workspace against the stored project metadata and
 * exposes the lightweight session/context surface the current multi-provider
 * architecture expects.
 */

import * as os from 'os';
import * as path from 'path';

import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { FileSystemProvider, FsDirent } from '@main/services/infrastructure/FileSystemProvider';
import type { Session } from '@main/types/domain';
import type { IAgentProvider, SystemContextFiles } from '@main/types/providers';

interface OpenCodeProjectRecord {
  id?: string;
  worktree?: string;
}

interface OpenCodeSessionRecord {
  id?: string;
  projectID?: string;
  directory?: string;
  path?: string;
  title?: string;
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
  };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
}

interface OpenCodeTokenMetadata {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens: number;
}

export class OpenCodeAdapter implements IAgentProvider {
  readonly id = 'opencode';
  readonly name = 'OpenCode';

  constructor(private projectScanner: ProjectScanner) {}

  async detectSession(projectPath: string): Promise<boolean> {
    const fsProvider = this.projectScanner.getFileSystemProvider();
    const projectsDir = this.getStorageProjectsDir();
    if (!(await fsProvider.exists(projectsDir))) {
      return false;
    }

    const match = await this.findProjectForWorkspace(projectPath, fsProvider);
    if (!match) {
      return false;
    }

    const sessionDir = path.join(this.getStorageRoot(), 'session', match.id);
    const sessions = await this.readJsonFiles(sessionDir, fsProvider);
    return sessions.length > 0;
  }

  async parseSessionLog(logFilePath: string): Promise<Session> {
    const fsProvider = this.projectScanner.getFileSystemProvider();
    const fallbackStat = await this.safeStat(logFilePath, fsProvider);
    const raw = await this.safeReadJson<OpenCodeSessionRecord>(logFilePath, fsProvider);
    const sessionId = path.basename(logFilePath, path.extname(logFilePath));
    const projectId = raw?.projectID ?? path.basename(path.dirname(logFilePath));
    const projectPath = (await this.readProjectWorktree(projectId, fsProvider))
      ?? raw?.directory
      ?? raw?.path
      ?? path.dirname(logFilePath);
    const messageCount = await this.countMessages(sessionId, fsProvider);
    const createdAt = this.toNumber(raw?.time?.created) ?? fallbackStat?.birthtimeMs ?? Date.now();
    const updatedAt = this.toNumber(raw?.time?.updated) ?? fallbackStat?.mtimeMs;

    return {
      id: raw?.id ?? sessionId,
      projectId,
      projectPath,
      createdAt: Math.floor(createdAt),
      updatedAt: updatedAt !== undefined ? Math.floor(updatedAt) : undefined,
      firstMessage: raw?.title,
      messageTimestamp: new Date(createdAt).toISOString(),
      hasSubagents: false,
      messageCount,
      isOngoing: raw?.time?.archived === undefined,
      gitBranch: undefined,
      metadataLevel: 'light',
      contextConsumption: undefined,
      compactionCount: undefined,
      phaseBreakdown: undefined,
    };
  }

  async parseSystemContext(workspacePath: string): Promise<SystemContextFiles> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Map values remain provider-specific by design.
    const files = new Map<string, any>();
    const fsProvider = this.projectScanner.getFileSystemProvider();
    const configRoot = path.join(workspacePath, '.opencode');

    if (!(await fsProvider.exists(configRoot))) {
      return { files };
    }

    await this.collectContextFiles(configRoot, fsProvider, files);
    return { files };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Metadata shape stays provider-specific until a shared contract exists.
  extractMetadata(logLines: any[]): OpenCodeTokenMetadata {
    const totals: OpenCodeTokenMetadata = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      totalTokens: 0,
    };

    if (!Array.isArray(logLines)) {
      return totals;
    }

    for (const line of logLines) {
      const tokens = this.getRecord(line, 'tokens') ?? this.getRecord(this.getRecord(line, 'info'), 'tokens');
      if (!tokens) {
        continue;
      }

      const input = this.toNumber(tokens.input) ?? 0;
      const output = this.toNumber(tokens.output) ?? 0;
      const cacheRead = this.toNumber(this.getRecord(tokens, 'cache')?.read);
      const cacheWrite = this.toNumber(this.getRecord(tokens, 'cache')?.write);

      totals.inputTokens += input;
      totals.outputTokens += output;
      if (cacheRead !== undefined) {
        totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + cacheRead;
      }
      if (cacheWrite !== undefined) {
        totals.cacheCreationTokens = (totals.cacheCreationTokens ?? 0) + cacheWrite;
      }
    }

    totals.totalTokens =
      totals.inputTokens +
      totals.outputTokens +
      (totals.cacheReadTokens ?? 0) +
      (totals.cacheCreationTokens ?? 0);

    return totals;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Semantic steps are still provider-specific and intentionally lightweight here.
  extractSemanticSteps(_logLines: any[]): any[] {
    return [];
  }

  private getDataRoot(): string {
    const xdgDataHome = process.env.XDG_DATA_HOME;
    if (xdgDataHome && xdgDataHome.length > 0) {
      return path.join(xdgDataHome, 'opencode');
    }

    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'opencode');
    }

    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData && localAppData.length > 0) {
        return path.join(localAppData, 'opencode');
      }
      return path.join(os.homedir(), 'AppData', 'Local', 'opencode');
    }

    return path.join(os.homedir(), '.local', 'share', 'opencode');
  }

  private getStorageRoot(): string {
    return path.join(this.getDataRoot(), 'storage');
  }

  private getStorageProjectsDir(): string {
    return path.join(this.getStorageRoot(), 'project');
  }

  private async findProjectForWorkspace(
    workspacePath: string,
    fsProvider: FileSystemProvider,
  ): Promise<{ id: string; worktree: string } | null> {
    const targetPath = this.normaliseWorkspacePath(workspacePath);
    const projects = await this.readJsonFiles(this.getStorageProjectsDir(), fsProvider);

    for (const { id: fileId, content } of projects) {
      const project = content as OpenCodeProjectRecord;
      if (typeof project.worktree !== 'string') {
        continue;
      }

      if (this.normaliseWorkspacePath(project.worktree) !== targetPath) {
        continue;
      }

      return {
        id: project.id ?? fileId,
        worktree: project.worktree,
      };
    }

    return null;
  }

  private async readProjectWorktree(
    projectId: string,
    fsProvider: FileSystemProvider,
  ): Promise<string | undefined> {
    const projectPath = path.join(this.getStorageProjectsDir(), `${projectId}.json`);
    const project = await this.safeReadJson<OpenCodeProjectRecord>(projectPath, fsProvider);
    return typeof project?.worktree === 'string' ? project.worktree : undefined;
  }

  private async countMessages(sessionId: string, fsProvider: FileSystemProvider): Promise<number> {
    const messageDir = path.join(this.getStorageRoot(), 'message', sessionId);
    const files = await this.readJsonFiles(messageDir, fsProvider);
    return files.length;
  }

  private async collectContextFiles(
    dirPath: string,
    fsProvider: FileSystemProvider,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Map values remain provider-specific by design.
    files: Map<string, any>,
  ): Promise<void> {
    let entries: FsDirent[];
    try {
      entries = await fsProvider.readdir(dirPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.collectContextFiles(fullPath, fsProvider, files);
        continue;
      }

      if (!entry.isFile() || !this.isContextFile(entry.name)) {
        continue;
      }

      try {
        const content = await fsProvider.readFile(fullPath, 'utf-8');
        files.set(fullPath, {
          path: fullPath,
          content,
          source: '.opencode',
        });
      } catch {
        continue;
      }
    }
  }

  private isContextFile(fileName: string): boolean {
    return /\.(md|json|jsonc|ya?ml)$/i.test(fileName);
  }

  private async readJsonFiles(
    dirPath: string,
    fsProvider: FileSystemProvider,
  ): Promise<{ id: string; content: unknown }[]> {
    if (!(await fsProvider.exists(dirPath))) {
      return [];
    }

    let entries: FsDirent[];
    try {
      entries = await fsProvider.readdir(dirPath);
    } catch {
      return [];
    }

    const results: { id: string; content: unknown }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      const content = await this.safeReadJson(fullPath, fsProvider);
      if (content === null) {
        continue;
      }

      results.push({
        id: path.basename(entry.name, '.json'),
        content,
      });
    }

    return results;
  }

  private async safeReadJson<T>(
    filePath: string,
    fsProvider: FileSystemProvider,
  ): Promise<T | null> {
    try {
      const raw = await fsProvider.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async safeStat(
    filePath: string,
    fsProvider: FileSystemProvider,
  ): Promise<{ birthtimeMs: number; mtimeMs: number } | null> {
    try {
      const stat = await fsProvider.stat(filePath);
      return {
        birthtimeMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  private getRecord(value: unknown, key: string): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const child = record[key];
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      return null;
    }

    return child as Record<string, unknown>;
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  private normaliseWorkspacePath(value: string): string {
    const normalised = path.resolve(value);
    return process.platform === 'win32' ? normalised.toLowerCase() : normalised;
  }
}
