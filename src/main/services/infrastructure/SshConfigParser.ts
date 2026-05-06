/**
 * SshConfigParser - Parses ~/.ssh/config to resolve host aliases.
 *
 * Two responsibilities:
 * - `getHosts()`: enumerate every Host alias for the dropdown autocomplete.
 *   Uses a line-based scanner because the `ssh-config` library was silently
 *   dropping hosts in some configurations (mixed indentation, comment-heavy
 *   sections, Include directives). For the dropdown we just need the names —
 *   not full config resolution — so a forgiving parser is the right tool.
 * - `resolveHost()`: full per-alias resolution. Uses the `ssh-config` library
 *   which understands `Match`, multi-alias Host lines, and config inheritance.
 *
 * Both methods follow `Include` directives, expanding paths and globs.
 */

import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SSHConfig from 'ssh-config';

import type { SshConfigHostEntry } from '@shared/types';

const logger = createLogger('Infrastructure:SshConfigParser');

export class SshConfigParser {
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? path.join(os.homedir(), '.ssh', 'config');
  }

  /**
   * Returns all defined Host aliases (excluding `*` wildcards and patterns).
   *
   * Uses a forgiving line-based scan instead of the `ssh-config` library so
   * that an unparseable block doesn't take out the rest of the config —
   * users have lots of weird stuff in their ssh_config (gcloud-generated
   * sections, OrbStack Includes, comment blocks).
   */
  async getHosts(): Promise<SshConfigHostEntry[]> {
    try {
      const content = await this.readExpandedConfig();
      if (content === null) return [];
      return parseHostListing(content);
    } catch (err) {
      logger.error('Failed to get SSH config hosts:', err);
      return [];
    }
  }

  /**
   * Resolves a host alias to its SSH config values.
   * Returns null if the alias is not found in config.
   */
  async resolveHost(alias: string): Promise<SshConfigHostEntry | null> {
    try {
      const config = await this.parseConfig();
      if (!config) return null;

      const resolved = this.resolveFromConfig(config, alias);

      // If nothing was resolved beyond the alias itself, check if host was actually defined
      if (
        !resolved.hostName &&
        !resolved.user &&
        !resolved.port &&
        !resolved.identityFiles?.length
      ) {
        const hasEntry = config.some(
          (section) =>
            section.type === SSHConfig.DIRECTIVE &&
            section.param === 'Host' &&
            typeof section.value === 'string' &&
            section.value.split(/\s+/).includes(alias)
        );
        if (!hasEntry) return null;
      }

      return resolved;
    } catch (err) {
      logger.error(`Failed to resolve SSH host "${alias}":`, err);
      return null;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private resolveFromConfig(config: SSHConfig, alias: string): SshConfigHostEntry {
    const computed = config.compute(alias);

    const rawHostName = computed.HostName;
    const hostName = Array.isArray(rawHostName) ? rawHostName[0] : rawHostName;
    const rawUser = computed.User;
    const user = Array.isArray(rawUser) ? rawUser[0] : (rawUser ?? undefined);
    const portStr = computed.Port;
    const port = portStr ? parseInt(String(portStr), 10) : undefined;
    const rawIdentityFile = computed.IdentityFile;
    const rawFiles = Array.isArray(rawIdentityFile)
      ? rawIdentityFile
      : rawIdentityFile != null
        ? [rawIdentityFile]
        : [];
    const identityFiles = rawFiles
      .filter((f): f is string => typeof f === 'string')
      .map((f) => f.replace(/^~(?=$|\/|\\)/, os.homedir()));

    return {
      alias,
      hostName: hostName && hostName !== alias ? hostName : undefined,
      user,
      port: port && port !== 22 ? port : undefined,
      identityFiles: identityFiles.length > 0 ? identityFiles : undefined,
    };
  }

  private async parseConfig(): Promise<SSHConfig | null> {
    const content = await this.readExpandedConfig();
    if (content === null) return null;
    try {
      return SSHConfig.parse(content);
    } catch (err) {
      logger.error('Failed to parse SSH config:', err);
      return null;
    }
  }

  private async readExpandedConfig(): Promise<string | null> {
    try {
      const content = await fs.promises.readFile(this.configPath, 'utf8');
      return await this.expandIncludes(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No SSH config file found at', this.configPath);
      } else {
        logger.error('Failed to read SSH config:', err);
      }
      return null;
    }
  }

  private async expandIncludes(content: string): Promise<string> {
    const lines = content.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const match =
        trimmed.startsWith('Include ') || trimmed.startsWith('include ')
          ? /^[Ii]nclude\s+(\S.*)$/.exec(trimmed)
          : null;

      if (!match) {
        result.push(line);
        continue;
      }

      const pattern = match[1].trim();
      const expandedPattern = pattern.replace(/^~/, os.homedir());

      try {
        if (expandedPattern.includes('*') || expandedPattern.includes('?')) {
          const dir = path.dirname(expandedPattern);
          const globPart = path.basename(expandedPattern);
          const files = await this.globFiles(dir, globPart);

          for (const file of files) {
            try {
              const included = await fs.promises.readFile(file, 'utf8');
              result.push(included);
            } catch {
              // Skip unreadable included files
            }
          }
        } else {
          const included = await fs.promises.readFile(expandedPattern, 'utf8');
          result.push(included);
        }
      } catch {
        // Skip unresolvable includes
      }
    }

    return result.join('\n');
  }

  private async globFiles(dir: string, pattern: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dir);
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      return entries.filter((e) => regex.test(e)).map((e) => path.join(dir, e));
    } catch {
      return [];
    }
  }
}

// =============================================================================
// Line-based host listing
// =============================================================================

/**
 * Walks the (already include-expanded) config text and returns one entry per
 * Host alias. Lenient: tolerates mixed indentation, `key=value` and `key value`
 * forms, and comments. Unrecognized directives are silently skipped.
 */
function parseHostListing(content: string): SshConfigHostEntry[] {
  const entries: SshConfigHostEntry[] = [];
  // Multiple aliases on the same `Host a b c` line share the same body, so we
  // accumulate to a list of "current entries" that all receive the next props.
  let current: SshConfigHostEntry[] = [];

  const flush = (): void => {
    for (const entry of current) {
      // Don't echo identity defaults that aren't explicitly set in the block.
      if (entry.identityFiles?.length === 0) {
        delete entry.identityFiles;
      }
      entries.push(entry);
    }
    current = [];
  };

  for (const rawLine of content.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const kv = parseKeyValue(line);
    if (!kv) continue;

    const key = kv.key.toLowerCase();
    const value = kv.value;

    if (key === 'host') {
      flush();
      const aliases = value.split(/\s+/).filter((a) => a && !a.includes('*') && !a.includes('?'));
      current = aliases.map((alias) => ({ alias }));
      continue;
    }

    if (current.length === 0) continue;

    for (const entry of current) {
      applyDirective(entry, key, value);
    }
  }

  flush();
  return entries;
}

/* eslint-disable no-param-reassign --
   `entry` is the in-progress builder for a Host block. Imperative mutation
   is the natural shape for a line-by-line parser; the alternative (returning
   a new object every line) would just churn allocations for no readability
   gain. */
function applyDirective(entry: SshConfigHostEntry, key: string, value: string): void {
  switch (key) {
    case 'hostname':
      if (value !== entry.alias) entry.hostName = value;
      break;
    case 'user':
      entry.user = value;
      break;
    case 'port': {
      const port = parseInt(value, 10);
      if (!Number.isNaN(port) && port !== 22) entry.port = port;
      break;
    }
    case 'identityfile': {
      const expanded = value.replace(/^~(?=$|\/|\\)/, os.homedir());
      if (!entry.identityFiles) entry.identityFiles = [];
      entry.identityFiles.push(expanded);
      break;
    }
    default:
      // Unrecognized directives don't appear in the dropdown; ignore.
      break;
  }
}
/* eslint-enable no-param-reassign -- end builder mutation block */

function stripComment(line: string): string {
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  // Both `Key Value ...` and `Key=Value ...` are valid in OpenSSH config.
  // Avoid regex to keep this linear-time on long lines.
  const eqIdx = line.indexOf('=');
  const wsIdx = findWhitespace(line);
  if (eqIdx !== -1 && (wsIdx === -1 || eqIdx < wsIdx)) {
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (!key) return null;
    return { key, value };
  }
  if (wsIdx === -1) return null;
  const key = line.slice(0, wsIdx);
  const value = line.slice(wsIdx + 1).trim();
  if (!key || !value) return null;
  return { key, value };
}

function findWhitespace(s: string): number {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09) return i;
  }
  return -1;
}
