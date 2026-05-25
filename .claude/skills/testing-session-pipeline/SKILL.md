---
name: testing-session-pipeline
description: Test session-level changes (parsing, chunking, metrics, exports) end-to-end. Use when verifying SessionMetrics changes, ChunkBuilder aggregation, sessionExporter output, ContextPanel content resolution, or anything that flows through the SessionParser → SubagentResolver → ChunkBuilder → sessionExporter pipeline.
---

# Testing the session pipeline

This skill covers how to test changes that affect any part of the
`~/.claude/projects/*.jsonl` → parsed session → chunks → rendered surfaces
pipeline. Common targets: `SessionMetrics`, `ChunkBuilder.getTotalChunkMetrics`,
`SubagentResolver`, `sessionExporter`, `SessionContextPanel`, `MetricsPill`.

## When to use this skill

- A change touches `SessionMetrics` (optional fields, new fields, defaults).
- A change touches aggregators in `ChunkBuilder`, `SubagentResolver`, or any
  export utility.
- A change touches CLAUDE.md / context injection rendering.
- A change adds a new `IAgentProvider` adapter or modifies the `AgentRegistry`.

## Setup — synthetic JSONL fixture

1. Pick a workspace path on the VM and create it, e.g.
   `/home/ubuntu/fixture-project/`.
2. Encode the path: `/home/ubuntu/fixture-project` → `-home-ubuntu-fixture-project`
   (slashes replaced by dashes, leading dash kept). Create the encoded
   directory under `~/.claude/projects/`.
3. Write a JSONL session with at least one user turn and one assistant turn.
   Each line is a single JSON object. Required-ish top-level keys:
   `type` (`"user"` or `"assistant"`), `parentUuid`, `isSidechain`,
   `userType`, `cwd`, `sessionId`, `version`, `gitBranch`, `timestamp`,
   `uuid`, `message`.
4. For assistant turns, the `message` object should match Anthropic's API
   shape: `role`, `model`, `id`, `type: "message"`, `content`, `stop_reason`,
   and crucially `usage: { input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens? }`.
5. To test the **optional cache token path** specifically, add a second
   assistant turn whose `usage` block omits `cache_read_input_tokens` and
   `cache_creation_input_tokens` entirely. The aggregators must continue to
   return finite numbers (the `?? 0` defensive pattern).
6. To exercise `SessionContextPanel` CLAUDE.md rendering, place a `CLAUDE.md`
   with a known marker string in the fixture project root.

## Launching the Electron dev app (live, recordable)

The dev launch uses electron-vite. On Linux VMs:

- Launch with `DISPLAY=:0 pnpm dev` so the window appears on the live
  user-visible X server. `xvfb-run` works but the user cannot see the window
  through the Devin Browser/Desktop tab.
- The first launch will tell you the window name (e.g. "claude-devtools").
  Use `DISPLAY=:0 xdotool search --name claude-devtools` to grab the window
  id for resizing and screenshots.
- **Preexisting hazard:** `tailwind.config.js` uses CJS `module.exports`
  under `"type": "module"` in package.json. On Node 22 this throws
  `ReferenceError: module is not defined` during dev launch. If that
  happens, rename it to `tailwind.config.cjs` locally for the test run and
  **revert the rename before committing**. This is preexisting on `main`,
  not introduced by any current PR.
- Devtools shortcuts (F12 / Ctrl+Shift+I) may be disabled by the app. If you
  need to script the renderer, prefer running the same code path as a
  vitest test (see below) over trying to open DevTools.

## Running the IPC pipeline from vitest

The IPC handler `get-session-detail`
(`src/main/ipc/sessions.ts`) does:

```ts
const parsedSession = await sessionParser.parseSession(projectId, sessionId);
const subagents = await subagentResolver.resolveSubagents(
  projectId, sessionId, parsedSession.taskCalls, parsedSession.messages,
);
const detail = chunkBuilder.buildSessionDetail(
  session, parsedSession.messages, subagents,
);
```

Reproduce that from a vitest test to verify metrics / export output without
running the full Electron app. Key details:

- `test/setup.ts` overrides `process.env.HOME` to `/home/testuser`. Re-stub
  to `/home/ubuntu` before any module loads (top-level of the test file).
- `ClaudeMdReader` imports `app` from `electron` for `app.getPath('home')`.
  Mock `electron` with `vi.mock('electron', () => ({ app: { getPath: () => '/home/ubuntu' } }))`.
- `ProjectScanner` constructor is
  `(projectsDir?, todosDir?, fsProvider?)` — pass strings, not the
  FileSystemProvider. Default fsProvider is fine for real filesystem reads.
- Use `exportAsPlainText` / `exportAsMarkdown` from
  `@renderer/utils/sessionExporter` to verify the formatted output.
- The renderer's `ExportDropdown` component exists but is currently not
  wired into any layout. The export utilities are still the source of truth
  for any export rendering — call them directly.

## Cleanup

- Delete the fixture project directory and the encoded
  `~/.claude/projects/-home-...` directory.
- Restore `tailwind.config.js` if you renamed it for the dev launch.
- Kill any backgrounded `pnpm dev` / Electron processes:
  `pkill -f 'pnpm dev' && pkill -f electron-vite && pkill -f electron`.
- Verify `git status -s` is empty before reporting completion.

## Pass criteria for cache-token / SessionMetrics changes

When the change makes a previously-required field optional or adds a new
optional field, the test must demonstrate **both** paths:

1. Field **present** → exact value flows through aggregator and into the
   export output (plain text + markdown).
2. Field **absent** → aggregator returns a finite number (no `NaN`), and the
   export output does not contain `NaN` or `undefined`.

## Devin Secrets Needed

None — this skill operates entirely on local fixture data.
