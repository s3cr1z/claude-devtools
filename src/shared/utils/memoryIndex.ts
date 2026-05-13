/**
 * Pure parser for MEMORY.md — the index file that lives in
 * ~/.claude/projects/<encoded>/memory/MEMORY.md
 *
 * Format (loose):
 *   # Memory index
 *
 *   - [Title](file.md) — short hook describing the layer
 *   - [Another](other.md) - alt-dash also accepted
 *
 * Lines that don't match are kept in `rawMarkdown` so callers can still
 * render any preamble or section headers verbatim.
 */

export interface MemoryEntry {
  title: string;
  file: string;
  hook: string;
  lineNumber: number;
}

export interface MemoryIndex {
  rawMarkdown: string;
  entries: MemoryEntry[];
  orphanFiles: string[];
}

// Bounded character classes throughout (no `.+?`) to guarantee linear-time
// matching even on adversarial input. The negated classes can't include
// their own terminator (`]` or `)`), so the engine never backtracks.
// eslint-disable-next-line sonarjs/slow-regex -- bounded negated char classes, no backtracking
const ENTRY_REGEX = /^\s*-\s*\[([^\]\n]+)\]\(([^)\n]+\.md)\)\s*(?:[—–-]\s*(.*))?$/;

export function parseMemoryIndex(markdown: string, dirListing: readonly string[]): MemoryIndex {
  const entries: MemoryEntry[] = [];
  const seenFiles = new Set<string>();
  const lines = markdown.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const match = ENTRY_REGEX.exec(line);
    if (!match) return;
    const [, title, file, hook] = match;
    if (!title || !file) return;
    entries.push({
      title: title.trim(),
      file: file.trim(),
      hook: (hook ?? '').trim(),
      lineNumber: idx + 1,
    });
    seenFiles.add(file.trim());
  });

  const orphanFiles = dirListing
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .filter((name) => name !== 'MEMORY.md' && !seenFiles.has(name))
    .sort((a, b) => a.localeCompare(b));

  return { rawMarkdown: markdown, entries, orphanFiles };
}
