/**
 * Agent registry — central catalog of agent runtime adapters.
 *
 * The registry owns a list of {@link IAgentProvider} instances and exposes a
 * minimal API for discovering which adapter should service a given workspace.
 * New providers can be added either at construction time (see the built-in
 * {@link ClaudeAdapter} / {@link AntigravityAdapter} registrations) or at
 * runtime via {@link registerProvider}, enabling extension without touching
 * call sites.
 */

import { AntigravityAdapter } from '../parsing/adapters/AntigravityAdapter';
import { ClaudeAdapter } from '../parsing/adapters/ClaudeAdapter';

import type { ProjectScanner } from './ProjectScanner';
import type { IAgentProvider } from '@main/types/providers';

export class AgentRegistry {
  private providers: IAgentProvider[] = [];

  constructor(projectScanner: ProjectScanner) {
    this.registerProvider(new ClaudeAdapter(projectScanner));
    this.registerProvider(new AntigravityAdapter(projectScanner));
  }

  /** Adds a provider to the registry. */
  registerProvider(provider: IAgentProvider): void {
    this.providers.push(provider);
  }

  /** Returns all currently registered providers (registration order). */
  listProviders(): IAgentProvider[] {
    return this.providers;
  }

  /**
   * Returns the first provider that reports a session for the given workspace,
   * or `null` if no provider claims the workspace.
   *
   * Registration order acts as priority — {@link ClaudeAdapter} is registered
   * first to preserve historical behaviour for Claude Code workspaces.
   */
  async getProviderForWorkspace(workspacePath: string): Promise<IAgentProvider | null> {
    for (const provider of this.providers) {
      if (await provider.detectSession(workspacePath)) {
        return provider;
      }
    }
    return null;
  }
}
