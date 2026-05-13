/**
 * Memory slice — per-project Claude memory state.
 *
 * Holds:
 *  - whether each project has a memory directory
 *  - the parsed MEMORY.md index per project
 *  - lazily-loaded file contents (loaded on first expand)
 *  - the set of currently-expanded entries per project
 */

import { api } from '@renderer/api';

import type { AppState } from '../types';
import type { MemoryIndex } from '@shared/types';
import type { StateCreator } from 'zustand';

function fileCacheKey(projectId: string, fileName: string): string {
  return `${projectId}::${fileName}`;
}

// `Record<string, T | undefined>` (rather than plain `Record<string, T>`) so
// "key not present" is statically representable and the slice consumers can
// distinguish "not loaded yet" from a falsy loaded value.
export interface MemorySlice {
  hasMemoryByProjectId: Record<string, boolean | undefined>;
  indexByProjectId: Record<string, MemoryIndex | null | undefined>;
  expandedEntriesByProjectId: Record<string, string[] | undefined>;
  fileContents: Record<string, string | undefined>;
  memoryLoadingByProjectId: Record<string, boolean | undefined>;
  memoryError: string | null;

  loadMemoryForProject: (projectId: string) => Promise<void>;
  toggleMemoryEntry: (projectId: string, fileName: string) => Promise<void>;
  refreshMemoryForProject: (projectId: string) => Promise<void>;
  openMemoryTab: (projectId: string) => void;
}

export const createMemorySlice: StateCreator<AppState, [], [], MemorySlice> = (set, get) => ({
  hasMemoryByProjectId: {},
  indexByProjectId: {},
  expandedEntriesByProjectId: {},
  fileContents: {},
  memoryLoadingByProjectId: {},
  memoryError: null,

  loadMemoryForProject: async (projectId: string): Promise<void> => {
    if (!projectId) return;
    set((state) => ({
      memoryLoadingByProjectId: { ...state.memoryLoadingByProjectId, [projectId]: true },
      memoryError: null,
    }));
    try {
      const has = await api.memory.hasMemory(projectId);
      let index: MemoryIndex | null = null;
      if (has) {
        index = await api.memory.getIndex(projectId);
      }
      set((state) => ({
        hasMemoryByProjectId: { ...state.hasMemoryByProjectId, [projectId]: has },
        indexByProjectId: { ...state.indexByProjectId, [projectId]: index },
        memoryLoadingByProjectId: { ...state.memoryLoadingByProjectId, [projectId]: false },
      }));
    } catch (error) {
      set((state) => ({
        memoryError: error instanceof Error ? error.message : 'Failed to load memory',
        memoryLoadingByProjectId: { ...state.memoryLoadingByProjectId, [projectId]: false },
      }));
    }
  },

  toggleMemoryEntry: async (projectId: string, fileName: string): Promise<void> => {
    const state = get();
    const expanded = state.expandedEntriesByProjectId[projectId] ?? [];
    const isOpen = expanded.includes(fileName);

    if (isOpen) {
      set({
        expandedEntriesByProjectId: {
          ...state.expandedEntriesByProjectId,
          [projectId]: expanded.filter((f) => f !== fileName),
        },
      });
      return;
    }

    set({
      expandedEntriesByProjectId: {
        ...state.expandedEntriesByProjectId,
        [projectId]: [...expanded, fileName],
      },
    });

    const cacheKey = fileCacheKey(projectId, fileName);
    if (state.fileContents[cacheKey] !== undefined) return;

    try {
      const result = await api.memory.readFile(projectId, fileName);
      if (result.success) {
        set((s) => ({ fileContents: { ...s.fileContents, [cacheKey]: result.content } }));
      } else {
        set((s) => ({
          fileContents: {
            ...s.fileContents,
            [cacheKey]: `> Failed to read ${fileName}: ${result.error}`,
          },
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((s) => ({
        fileContents: {
          ...s.fileContents,
          [cacheKey]: `> Failed to read ${fileName}: ${message}`,
        },
      }));
    }
  },

  openMemoryTab: (projectId: string): void => {
    if (!projectId) return;
    const state = get();
    // Reuse an existing memory tab for this project if one is already open.
    for (const pane of state.paneLayout.panes) {
      const existing = pane.tabs.find((t) => t.type === 'memory' && t.projectId === projectId);
      if (existing) {
        state.setActiveTab(existing.id);
        return;
      }
    }
    state.openTab({
      type: 'memory',
      projectId,
      label: 'Memory',
    });
  },

  refreshMemoryForProject: async (projectId: string): Promise<void> => {
    if (!projectId) return;
    // Invalidate cached file contents for this project so re-expanding refetches.
    set((state) => {
      const next: Record<string, string | undefined> = {};
      const prefix = `${projectId}::`;
      for (const [key, value] of Object.entries(state.fileContents)) {
        if (!key.startsWith(prefix)) next[key] = value;
      }
      return { fileContents: next };
    });
    await get().loadMemoryForProject(projectId);
  },
});
