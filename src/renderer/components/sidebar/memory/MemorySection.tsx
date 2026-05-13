/**
 * MemorySection — single sidebar row that opens the per-project memory in
 * a new tab/pane. Only rendered when the active project has a memory
 * directory containing at least one .md file.
 *
 * The row itself opens the Memory pane. The `⋯` button on the right is the
 * cross-platform "Open in…" launcher pointed at the memory *folder* — handy
 * for revealing the directory in Finder/Explorer or opening it in an IDE
 * without having to navigate into a specific layer first.
 */

import { useEffect } from 'react';

import { useStore } from '@renderer/store';
import { Brain } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { OpenInMenu } from './OpenInMenu';

export const MemorySection = (): React.JSX.Element | null => {
  const {
    selectedProjectId,
    hasMemory,
    indexEntryCount,
    loading,
    loadMemoryForProject,
    openMemoryTab,
  } = useStore(
    useShallow((s) => {
      const projectId = s.selectedProjectId;
      const index = projectId ? s.indexByProjectId[projectId] : null;
      const entryCount = (index?.entries.length ?? 0) + (index?.orphanFiles.length ?? 0);
      return {
        selectedProjectId: projectId,
        hasMemory: projectId ? s.hasMemoryByProjectId[projectId] : undefined,
        indexEntryCount: entryCount,
        loading: projectId ? (s.memoryLoadingByProjectId[projectId] ?? false) : false,
        loadMemoryForProject: s.loadMemoryForProject,
        openMemoryTab: s.openMemoryTab,
      };
    })
  );

  useEffect(() => {
    if (!selectedProjectId) return;
    if (hasMemory === undefined) void loadMemoryForProject(selectedProjectId);
  }, [selectedProjectId, hasMemory, loadMemoryForProject]);

  if (!selectedProjectId) return null;
  if (hasMemory === undefined && loading) return null;
  if (!hasMemory) return null;

  return (
    <div
      className="flex w-full items-center gap-1 border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <button
        type="button"
        onClick={(): void => openMemoryTab(selectedProjectId)}
        className="flex flex-1 items-center gap-1.5 text-left hover:text-text-secondary"
      >
        <Brain size={13} className="shrink-0" aria-hidden="true" />
        <span>Memory</span>
        {indexEntryCount > 0 && <span className="text-text-muted">({indexEntryCount})</span>}
      </button>
      <OpenInMenu projectId={selectedProjectId} fileName={null} />
    </div>
  );
};
