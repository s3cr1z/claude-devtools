/**
 * AgentRegistry — manages the set of AI agent providers available to the app.
 *
 * The registry owns a list of {@link IAgentProvider} instances and is
 * responsible for resolving which provider should handle a given workspace.
 * Today the only registered provider is the {@link ClaudeAdapter}, but the
 * registry is the seam where additional providers (e.g. Antigravity) will
 * plug in.
 */

import { ClaudeAdapter } from '../parsing/adapters/ClaudeAdapter';

import type { ProjectScanner } from './ProjectScanner';
import type { IAgentProvider } from '@main/types/providers';

export class AgentRegistry {
  private providers: IAgentProvider[] = [];

  constructor(projectScanner: ProjectScanner) {
    // Claude Code is registered by default so existing behaviour is unchanged.
    this.registerProvider(new ClaudeAdapter(projectScanner));
  }

  /** Register an additional provider with the registry. */
  registerProvider(provider: IAgentProvider): void {
    this.providers.push(provider);
  }

  /** Return every provider currently registered. */
  listProviders(): IAgentProvider[] {
    return this.providers;
  }

  /**
   * Find the first provider that reports it can handle the given workspace.
   * Returns null when no registered provider claims the workspace.
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
