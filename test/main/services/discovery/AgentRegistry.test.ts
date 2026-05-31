import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') {
        return process.env.HOME ?? os.homedir();
      }
      return '';
    },
  },
}));

import { AgentRegistry } from '../../../../src/main/services/discovery/AgentRegistry';
import { LocalFileSystemProvider } from '../../../../src/main/services/infrastructure/LocalFileSystemProvider';
import { OpenCodeAdapter } from '../../../../src/main/services/parsing/adapters/OpenCodeAdapter';
import { encodePath } from '../../../../src/main/utils/pathDecoder';

import type { ProjectScanner } from '../../../../src/main/services/discovery/ProjectScanner';

describe('AgentRegistry', () => {
  let tmpDir: string;
  let antigravityConversationsDir: string;
  let xdgDataHome: string;
  let claudeProjectsDir: string;
  let envXdgDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-test-'));
    antigravityConversationsDir = path.join(
      os.homedir(),
      '.gemini',
      'antigravity-ide',
      'conversations',
      `agent-registry-${path.basename(tmpDir)}`,
    );
    xdgDataHome = path.join(tmpDir, 'xdg-data');
    claudeProjectsDir = path.join(tmpDir, 'claude-projects');

    fs.mkdirSync(antigravityConversationsDir, { recursive: true });
    fs.mkdirSync(xdgDataHome, { recursive: true });
    fs.mkdirSync(claudeProjectsDir, { recursive: true });

    envXdgDataHome = process.env.XDG_DATA_HOME;

    process.env.XDG_DATA_HOME = xdgDataHome;
  });

  afterEach(() => {
    if (envXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = envXdgDataHome;
    }

    fs.rmSync(antigravityConversationsDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes each workspace to the provider that owns its session storage', async () => {
    const claudeWorkspace = path.join(tmpDir, 'workspaces', 'claude-app');
    const antigravityWorkspace = path.join(tmpDir, 'workspaces', 'gemini-app');
    const openCodeWorkspace = path.join(tmpDir, 'workspaces', 'opencode-app');

    fs.mkdirSync(path.join(claudeProjectsDir, encodePath(claudeWorkspace)), { recursive: true });

    fs.writeFileSync(
      path.join(antigravityConversationsDir, 'transcript.jsonl'),
      `${JSON.stringify({ workspacePath: antigravityWorkspace, role: 'user', content: 'hello' })}\n`,
      'utf8',
    );

    const openCodeStorageDir = path.join(xdgDataHome, 'opencode', 'storage');
    fs.mkdirSync(path.join(openCodeStorageDir, 'project'), { recursive: true });
    fs.mkdirSync(path.join(openCodeStorageDir, 'session', 'proj_opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(openCodeStorageDir, 'project', 'proj_opencode.json'),
      JSON.stringify({ id: 'proj_opencode', worktree: openCodeWorkspace }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(openCodeStorageDir, 'session', 'proj_opencode', 'ses_opencode.json'),
      JSON.stringify({
        id: 'ses_opencode',
        projectID: 'proj_opencode',
        directory: openCodeWorkspace,
        title: 'OpenCode session',
        time: { created: 1, updated: 2 },
      }),
      'utf8',
    );

    const registry = createRegistry(claudeProjectsDir);

    expect((await registry.getProviderForWorkspace(claudeWorkspace))?.id).toBe('claude-code');
    expect((await registry.getProviderForWorkspace(antigravityWorkspace))?.id).toBe('antigravity');
    expect((await registry.getProviderForWorkspace(openCodeWorkspace))?.id).toBe('opencode');
    expect(await registry.getProviderForWorkspace(path.join(tmpDir, 'workspaces', 'missing'))).toBeNull();
  });

  it('reads workspace-local OpenCode context files from .opencode', async () => {
    const workspacePath = path.join(tmpDir, 'workspaces', 'opencode-context');
    const agentPath = path.join(workspacePath, '.opencode', 'agents', 'helper.md');
    const configPath = path.join(workspacePath, '.opencode', 'opencode.jsonc');

    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    fs.writeFileSync(agentPath, '# helper\n', 'utf8');
    fs.writeFileSync(configPath, '{ "model": "opencode/gpt-5" }\n', 'utf8');

    const adapter = new OpenCodeAdapter(createProjectScanner(claudeProjectsDir));
    const result = await adapter.parseSystemContext(workspacePath);

    expect(result.files.get(agentPath)).toMatchObject({
      path: agentPath,
      content: '# helper\n',
      source: '.opencode',
    });
    expect(result.files.get(configPath)).toMatchObject({
      path: configPath,
      content: '{ "model": "opencode/gpt-5" }\n',
      source: '.opencode',
    });
  });
});

function createRegistry(projectsDir: string): AgentRegistry {
  return new AgentRegistry(createProjectScanner(projectsDir));
}

function createProjectScanner(projectsDir: string): ProjectScanner {
  const fsProvider = new LocalFileSystemProvider();
  return {
    getFileSystemProvider: () => fsProvider,
    getProjectsDir: () => projectsDir,
  } as unknown as ProjectScanner;
}
