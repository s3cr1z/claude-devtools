/**
 * AntigravityAdapter — implements IAgentProvider for Google Antigravity (Gemini CLI) sessions.
 *
 * Wraps Google Antigravity session detection and system-context reading so the
 * rest of the application can interact with Antigravity sessions through the
 * provider-agnostic IAgentProvider interface.
 *
 * The exact on-disk shape of Antigravity/Gemini session logs is not formally
 * documented in this repo; the parsing logic below is defensive and tries to
 * cover both JSONL (one JSON object per line) and JSON-array file formats,
 * along with the most common Gemini message shapes (e.g. `{ role, parts }`
 * and `{ role, content }` with `usageMetadata`/`functionCall` fields).
 */

import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

import type { ProjectScanner } from '@main/services/discovery/ProjectScanner';
import type { Session } from '@main/types/domain';
import type { IAgentProvider, SystemContextFiles } from '@main/types/providers';

// =============================================================================
// Adapter-local types
//
// These intentionally diverge from the richer `ParsedMessage`/`SemanticStep`
// shapes used by the Claude pipeline. The IAgentProvider contract exposes
// these as `any`/`any[]` so each provider can return its own light-weight
// shape until a unified cross-provider model is introduced.
// =============================================================================

type GeminiRole = 'user' | 'assistant' | 'system';

interface ParsedGeminiMessage {
  role: GeminiRole;
  content: string;
  timestamp: Date | null;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isToolResult?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface AntigravityTokenMetadata {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: undefined;
  cacheCreationTokens: undefined;
  totalTokens: number;
}

interface AntigravitySemanticStep {
  type: 'tool_call' | 'tool_result' | 'text';
  content: string;
  timestamp: Date;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

const MAX_FIRST_MESSAGE_LENGTH = 500;

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
   * Reads the file via the configured FileSystemProvider. If the file appears
   * to be a JSON array (starts with `[`) that shape is tried first; otherwise
   * the content is treated as JSONL (one JSON object per line). Parsing errors
   * for individual entries are swallowed so a single malformed line cannot
   * prevent the rest of the session from being surfaced.
   */
  async parseSessionLog(logFilePath: string): Promise<Session> {
    const fsProvider = this.projectScanner.getFileSystemProvider();

    let rawContent = '';
    try {
      rawContent = await fsProvider.readFile(logFilePath, 'utf-8');
    } catch (err) {
      console.error(
        `[AntigravityAdapter] Failed to read session log ${logFilePath}:`,
        err,
      );
    }

    const lines = this.splitIntoEntries(rawContent);
    const parsed: ParsedGeminiMessage[] = [];
    for (const line of lines) {
      const message = this.parseGeminiMessage(line);
      if (message) {
        parsed.push(message);
      }
    }

    // Filesystem fallbacks for missing timestamps.
    let birthtimeMs: number | undefined;
    let mtimeMs: number | undefined;
    try {
      const stat = await fsProvider.stat(logFilePath);
      birthtimeMs = stat.birthtimeMs;
      mtimeMs = stat.mtimeMs;
    } catch (err) {
      console.error(
        `[AntigravityAdapter] Failed to stat session log ${logFilePath}:`,
        err,
      );
    }

    // Antigravity logs live under `~/.gemini/antigravity-ide/conversations/`,
    // so `path.dirname(logFilePath)` typically points at that shared storage
    // directory rather than the user's workspace. Probe the parsed entries for
    // an embedded workspace path first and fall back to the log directory only
    // when nothing better is available.
    const probedWorkspace = this.probeWorkspacePath(rawContent);
    const projectPath = probedWorkspace ?? path.dirname(logFilePath);
    const projectId = this.deriveProjectId(projectPath);
    const id = this.deriveSessionId(logFilePath);

    const firstUserMessage = parsed.find((m) => m.role === 'user' && m.content.length > 0);
    const firstMessage = firstUserMessage
      ? firstUserMessage.content.slice(0, MAX_FIRST_MESSAGE_LENGTH)
      : undefined;

    const firstTimestamp = parsed.find((m) => m.timestamp !== null)?.timestamp ?? null;
    const lastTimestamp = [...parsed].reverse().find((m) => m.timestamp !== null)?.timestamp ?? null;

    const createdAt = Math.floor(
      firstTimestamp?.getTime() ?? birthtimeMs ?? Date.now(),
    );
    const updatedAtRaw = lastTimestamp?.getTime() ?? mtimeMs;
    const updatedAt = updatedAtRaw !== undefined ? Math.floor(updatedAtRaw) : undefined;

    const firstUserTimestamp = firstUserMessage?.timestamp ?? null;
    const messageTimestamp = firstUserTimestamp
      ? firstUserTimestamp.toISOString()
      : firstTimestamp?.toISOString();

    return {
      id,
      projectId,
      projectPath,
      createdAt,
      updatedAt,
      firstMessage,
      messageTimestamp,
      hasSubagents: false,
      messageCount: parsed.length,
      isOngoing: this.detectOngoing(parsed),
      gitBranch: undefined,
      metadataLevel: 'light',
      // Antigravity logs don't expose context/compaction information yet, so
      // we intentionally leave these undefined — downstream UI is defensive.
      contextConsumption: undefined,
      compactionCount: undefined,
      phaseBreakdown: undefined,
    };
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
   * Extract Antigravity-specific token metadata from a list of log lines.
   *
   * Sums Gemini `usageMetadata` fields (`promptTokenCount`,
   * `candidatesTokenCount`, and `totalTokenCount`) across all entries.
   * Returns zeroed counters when no usage metadata is found so callers can
   * always render a consistent shape.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IAgentProvider contract uses `any` to stay provider-agnostic; per-provider log shapes differ.
  extractMetadata(logLines: any[]): AntigravityTokenMetadata {
    const result: AntigravityTokenMetadata = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      totalTokens: 0,
    };

    if (!Array.isArray(logLines)) {
      return result;
    }

    let totalOverride: number | undefined;

    for (const line of logLines) {
      const entry = this.normaliseEntry(line);
      if (!entry) continue;

      const usage = this.getUsageMetadata(entry);
      if (!usage) continue;

      const prompt = this.toNumber(usage.promptTokenCount);
      const candidates = this.toNumber(usage.candidatesTokenCount);
      const total = this.toNumber(usage.totalTokenCount);

      if (prompt !== undefined) result.inputTokens += prompt;
      if (candidates !== undefined) result.outputTokens += candidates;
      if (total !== undefined) {
        totalOverride = (totalOverride ?? 0) + total;
      }
    }

    result.totalTokens = totalOverride ?? result.inputTokens + result.outputTokens;
    return result;
  }

  /**
   * Extract semantic steps from a list of log lines.
   *
   * Looks for Gemini `functionCall`/`tool_use` structures inside `parts` or
   * top-level entries and maps them into the lightweight semantic step shape
   * used by Antigravity. Returns an empty array when no recognisable tool
   * activity is present.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IAgentProvider contract uses `any` to stay provider-agnostic; per-provider log shapes differ.
  extractSemanticSteps(logLines: any[]): AntigravitySemanticStep[] {
    if (!Array.isArray(logLines)) return [];

    const steps: AntigravitySemanticStep[] = [];
    for (const line of logLines) {
      const entry = this.normaliseEntry(line);
      if (!entry) continue;

      const timestamp = this.extractGeminiTimestamp(entry) ?? new Date();
      const parts = this.getParts(entry);

      for (const part of parts) {
        const functionCall = this.getRecord(part, 'functionCall') ?? this.getRecord(part, 'tool_use');
        if (functionCall) {
          const toolName = this.toStringValue(functionCall.name) ?? 'unknown';
          const toolInput = this.getRecord(functionCall, 'args')
            ?? this.getRecord(functionCall, 'arguments')
            ?? this.getRecord(functionCall, 'input')
            ?? {};
          steps.push({
            type: 'tool_call',
            content: toolName,
            timestamp,
            toolName,
            toolInput,
          });
          continue;
        }

        const functionResponse = this.getRecord(part, 'functionResponse')
          ?? this.getRecord(part, 'tool_result');
        if (functionResponse) {
          const toolName = this.toStringValue(functionResponse.name) ?? 'unknown';
          const response = functionResponse.response
            ?? functionResponse.content
            ?? functionResponse.output;
          steps.push({
            type: 'tool_result',
            content: this.stringifyContent(response),
            timestamp,
            toolName,
          });
          continue;
        }

        const text = this.toStringValue(part.text);
        if (text) {
          steps.push({ type: 'text', content: text, timestamp });
        }
      }
    }

    return steps;
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  /**
   * Parse a single line of an Antigravity log into a {@link ParsedGeminiMessage}.
   * Returns null when the line is empty, malformed JSON, or doesn't look like
   * a Gemini message entry.
   */
  parseGeminiMessage(line: string): ParsedGeminiMessage | null {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (!trimmed) return null;

    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch (err) {
      console.error('[AntigravityAdapter] Failed to parse Gemini log line:', err);
      return null;
    }

    return this.mapEntryToMessage(entry);
  }

  /**
   * Map a Gemini role to the application's internal role taxonomy.
   * Falls back to `'user'` for unknown values so messages aren't silently dropped.
   */
  mapGeminiRole(role: string): GeminiRole {
    const normalized = (role ?? '').toString().toLowerCase();
    if (normalized === 'model' || normalized === 'assistant') return 'assistant';
    if (normalized === 'system' || normalized === 'tool') return 'system';
    return 'user';
  }

  /**
   * Extract a timestamp from a Gemini log entry, trying a handful of common
   * field names (`createTime`, `timestamp`, `time`, `createdAt`). Returns
   * `null` when no recognised timestamp field is present so callers can apply
   * their own fallback (e.g. filesystem stat times) rather than getting a
   * misleading "now" value silently substituted.
   */
  extractGeminiTimestamp(entry: unknown): Date | null {
    const record = this.coerceEntry(entry);
    if (!record) return null;

    const candidates = [
      record.createTime,
      record.create_time,
      record.timestamp,
      record.time,
      record.createdAt,
      record.created_at,
      record.updateTime,
    ];

    for (const candidate of candidates) {
      const parsed = this.toDate(candidate);
      if (parsed) return parsed;
    }
    return null;
  }

  /**
   * Extract a printable text content string from a Gemini log entry,
   * concatenating `parts[].text` fragments when present.
   */
  extractGeminiContent(entry: unknown): string {
    const record = this.coerceEntry(entry);
    if (!record) return '';

    const directContent = this.toStringValue(record.content)
      ?? this.toStringValue(record.text)
      ?? this.toStringValue(record.message);
    if (directContent) return directContent;

    // `record.message` / `record.content` may also be nested objects (e.g.
    // `{ message: { content: "...", text: "..." } }` or the Gemini candidate
    // shape `{ content: { role, parts } }`). Probe those before falling through
    // to `parts[].text` aggregation so we don't lose the message body.
    const nestedSources = [
      this.coerceEntry(record.message),
      this.coerceEntry(record.content),
    ];
    for (const nested of nestedSources) {
      if (!nested) continue;
      const nestedDirect = this.toStringValue(nested.content)
        ?? this.toStringValue(nested.text)
        ?? this.toStringValue(nested.message);
      if (nestedDirect) return nestedDirect;
    }

    const parts = this.getParts(record);
    const fragments: string[] = [];
    for (const part of parts) {
      const text = this.toStringValue(part.text);
      if (text) fragments.push(text);
    }
    return fragments.join('').trim();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private mapEntryToMessage(entry: unknown): ParsedGeminiMessage | null {
    const record = this.coerceEntry(entry);
    if (!record) return null;

    const rawRole = this.toStringValue(record.role)
      ?? this.toStringValue(record.author)
      ?? this.toStringValue(this.coerceEntry(record.message)?.role)
      // Gemini candidate shape: `{ content: { role: "model", parts: [...] } }`.
      ?? this.toStringValue(this.coerceEntry(record.content)?.role);
    if (rawRole === undefined && !record.parts && !record.content && !record.text) {
      return null;
    }

    const role = this.mapGeminiRole(rawRole ?? 'user');
    const timestamp = this.extractGeminiTimestamp(record);
    const content = this.extractGeminiContent(record);

    const parts = this.getParts(record);
    let toolName: string | undefined;
    let toolInput: Record<string, unknown> | undefined;
    let isToolResult: boolean | undefined;

    for (const part of parts) {
      const functionCall = this.getRecord(part, 'functionCall') ?? this.getRecord(part, 'tool_use');
      if (functionCall) {
        toolName = this.toStringValue(functionCall.name) ?? toolName;
        toolInput = this.getRecord(functionCall, 'args')
          ?? this.getRecord(functionCall, 'arguments')
          ?? this.getRecord(functionCall, 'input')
          ?? toolInput;
        break;
      }
      const functionResponse = this.getRecord(part, 'functionResponse')
        ?? this.getRecord(part, 'tool_result');
      if (functionResponse) {
        toolName = this.toStringValue(functionResponse.name) ?? toolName;
        isToolResult = true;
        break;
      }
    }

    const usage = this.getUsageMetadata(record);
    return {
      role,
      content,
      timestamp,
      toolName,
      toolInput,
      isToolResult,
      inputTokens: usage ? this.toNumber(usage.promptTokenCount) : undefined,
      outputTokens: usage ? this.toNumber(usage.candidatesTokenCount) : undefined,
      totalTokens: usage ? this.toNumber(usage.totalTokenCount) : undefined,
    };
  }

  /**
   * Split a raw log file into per-entry strings. If the file appears to be a
   * JSON array (single document starting with `[`) that is tried first and each
   * element is re-emitted as a JSON string; otherwise we fall back to JSONL
   * (one JSON object per line) so {@link parseGeminiMessage} can process the
   * results uniformly.
   */
  private splitIntoEntries(rawContent: string): string[] {
    if (!rawContent) return [];

    const trimmed = rawContent.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[')) {
      try {
        const arr: unknown = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          return arr.map((entry) => JSON.stringify(entry));
        }
      } catch (err) {
        console.error('[AntigravityAdapter] Failed to parse JSON array log:', err);
        // Fall through to JSONL handling.
      }
    }

    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private detectOngoing(messages: ParsedGeminiMessage[]): boolean {
    if (messages.length === 0) return false;
    const last = messages[messages.length - 1];
    // Treat the session as "ongoing" when:
    //   - the last entry is a user prompt (the model hasn't replied yet);
    //   - the last entry is an assistant turn that issued a tool call (the
    //     tool result is still pending);
    //   - the last entry is a tool result (mapped to `system` role here) and
    //     the model hasn't produced a follow-up response yet;
    //   - the last entry is an empty assistant message (turn hasn't finished
    //     emitting any text or tool call).
    if (last.role === 'user') return true;
    if (last.role === 'system' && last.isToolResult) return true;
    if (last.role === 'assistant') {
      if (last.toolName && !last.isToolResult) return true;
      if (last.content.trim().length === 0 && !last.toolName) return true;
    }
    return false;
  }

  private deriveSessionId(logFilePath: string): string {
    const base = path.basename(logFilePath);
    const withoutExt = base.replace(/\.[^.]+$/, '');
    // `withoutExt` can be empty for dotfiles like `.log` (where the basename
    // is purely an extension). Fall back to the raw basename before reaching
    // for a UUID so the id still ties back to the file on disk.
    if (withoutExt.length > 0) return withoutExt;
    if (base.length > 0) return base;
    return randomUUID();
  }

  /**
   * Best-effort probe for a workspace/project path embedded in the raw log
   * content. Antigravity logs live under a shared conversations directory, so
   * the actual workspace must be recovered from per-entry metadata. We scan
   * for the most common field names without committing to a single schema.
   */
  private probeWorkspacePath(rawContent: string): string | undefined {
    if (!rawContent) return undefined;
    const fields = [
      'workspacePath',
      'workspace_path',
      'workspace',
      'projectPath',
      'project_path',
      'cwd',
      'rootPath',
      'root_path',
    ];
    for (const field of fields) {
      // Look for `"field": "..."` anywhere in the file. We intentionally do
      // not JSON.parse the whole document here — it may be JSONL and this
      // probe runs before per-entry parsing.
      const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
      const match = rawContent.match(pattern);
      if (match && match[1]) {
        try {
          // Re-use JSON's string decoding so escape sequences round-trip.
          const decoded = JSON.parse(`"${match[1]}"`) as string;
          if (decoded.length > 0) return decoded;
        } catch {
          // Fall through to next candidate.
        }
      }
    }
    return undefined;
  }

  private normaliseEntry(value: unknown): Record<string, unknown> | null {
    const direct = this.coerceEntry(value);
    if (direct) return direct;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        return this.coerceEntry(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return null;
  }

  private deriveProjectId(projectPath: string): string {
    // Mirror Claude's project-id convention: replace path separators with
    // dashes so the encoded id round-trips back to a directory name.
    return projectPath.replace(/[\\/]/g, '-');
  }

  private coerceEntry(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  }

  private getRecord(value: unknown, key: string): Record<string, unknown> | null {
    const record = this.coerceEntry(value);
    if (!record) return null;
    return this.coerceEntry(record[key]);
  }

  private getParts(entry: Record<string, unknown>): Record<string, unknown>[] {
    const parts: unknown =
      entry.parts ??
      (this.coerceEntry(entry.content)?.parts) ??
      (this.coerceEntry(entry.message)?.parts);

    if (!Array.isArray(parts)) return [];
    return parts.filter((p): p is Record<string, unknown> =>
      typeof p === 'object' && p !== null && !Array.isArray(p),
    );
  }

  private getUsageMetadata(entry: Record<string, unknown>): Record<string, unknown> | null {
    return (
      this.getRecord(entry, 'usageMetadata') ??
      this.getRecord(entry, 'usage_metadata') ??
      this.getRecord(entry, 'usage')
    );
  }

  private toStringValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  }

  private toDate(value: unknown): Date | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string' && value.length > 0) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  private stringifyContent(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      // Likely a cyclic structure or non-serialisable object — emit a stable
      // placeholder rather than letting JavaScript's `[object Object]`
      // default leak through (which the linter also flags).
      return '';
    }
  }
}
