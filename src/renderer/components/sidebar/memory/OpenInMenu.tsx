/**
 * "Open in…" dropdown — icon-rich app launcher modeled on image #7 of the
 * spec. Lists only the apps that detection found on disk. Numeric shortcuts
 * (1..9) fire while the menu is open; ⌘O opens Finder, ⌘⇧C copies the path.
 */

import { useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';
import {
  ChevronDown,
  Clipboard,
  FileCode,
  Folder,
  Hammer,
  type LucideIcon,
  Smartphone,
  SquareCode,
  Terminal as TerminalIcon,
} from 'lucide-react';

import type { OpenTarget, OpenTargetId } from '@shared/types';

interface OpenInMenuProps {
  projectId: string;
  /** null/undefined = open the memory folder; string = open a specific file */
  fileName: string | null;
  anchorClassName?: string;
  /** Optional trigger element override. Default is a small ⋯ button. */
  renderTrigger?: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  /**
   * Visual style of the trigger:
   *  - `dots` (default): ⋯ icon button — sidebar use.
   *  - `iconMenu`: pill-shaped trigger like the screenshot reference, used in
   *    the memory pane toolbar. Shows a folder icon + last-used label + ▾.
   */
  variant?: 'dots' | 'iconMenu';
}

const ICON_LABEL_OVERRIDE: Record<string, string> = {
  finder: 'Finder',
  explorer: 'Explorer',
  files: 'Files',
};

const ICON_BY_ID: Record<OpenTargetId, LucideIcon> = {
  finder: Folder,
  cursor: FileCode,
  vscode: FileCode,
  zed: SquareCode,
  'android-studio': Smartphone,
  xcode: Hammer,
  ghostty: TerminalIcon,
  iterm: TerminalIcon,
  terminal: TerminalIcon,
  antigravity: SquareCode,
  'copy-path': Clipboard,
};

function shortcutHint(target: OpenTarget, isFirst: boolean): string {
  if (target.id === 'copy-path') return '⌘⇧C';
  if (isFirst) return '⌘O';
  return target.shortcutKey ?? '';
}

export const OpenInMenu = ({
  projectId,
  fileName,
  anchorClassName,
  renderTrigger,
  variant = 'dots',
}: OpenInMenuProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (targets.length > 0) return;
    let cancelled = false;
    void api.memory.listAvailableOpeners().then((list) => {
      if (!cancelled) setTargets(list);
    });
    return (): void => {
      cancelled = true;
    };
  }, [targets.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return (): void => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const dispatch = async (targetId: OpenTargetId): Promise<void> => {
    setOpen(false);
    if (targetId === 'copy-path') {
      await api.memory.copyPath(projectId, fileName);
      return;
    }
    await api.memory.openIn(projectId, fileName, targetId);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'o') {
        const first = targets[0];
        if (first) {
          e.preventDefault();
          void dispatch(first.id);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        const copy = targets.find((t) => t.id === 'copy-path');
        if (copy) {
          e.preventDefault();
          void dispatch(copy.id);
        }
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        const target = targets[idx];
        if (target) {
          e.preventDefault();
          void dispatch(target.id);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return (): void => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispatch reads projectId/fileName via closure; intentionally rebound only when menu visibility or detected targets change
  }, [open, targets]);

  let trigger: React.ReactNode;
  if (renderTrigger) {
    trigger = renderTrigger({ open, toggle: () => setOpen((v) => !v) });
  } else if (variant === 'iconMenu') {
    const label = fileName ?? 'memory';
    trigger = (
      <button
        type="button"
        aria-label="Open in…"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-text hover:bg-surface-raised"
        style={{
          backgroundColor: 'var(--color-surface-overlay)',
          borderColor: 'var(--color-border-emphasis)',
        }}
      >
        <Folder size={14} className="text-text-secondary" aria-hidden="true" />
        <span className="max-w-[180px] truncate">{label}</span>
        <ChevronDown size={12} className="text-text-muted" aria-hidden="true" />
      </button>
    );
  } else {
    trigger = (
      <button
        type="button"
        aria-label="Open in…"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="rounded px-1.5 py-0.5 text-xs text-text-muted hover:bg-surface-overlay"
      >
        ⋯
      </button>
    );
  }

  return (
    <div ref={containerRef} className={`relative inline-block ${anchorClassName ?? ''}`}>
      {trigger}
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-[220px] overflow-hidden rounded-md border shadow-lg"
          style={{
            backgroundColor: 'var(--color-surface-overlay)',
            borderColor: 'var(--color-border-emphasis)',
          }}
        >
          {targets.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-muted">Detecting apps…</div>
          ) : (
            targets.map((target, idx) => {
              const isFirst = idx === 0;
              const isCopy = target.id === 'copy-path';
              const hint = shortcutHint(target, isFirst);
              const labelOverride = ICON_LABEL_OVERRIDE[target.iconName];
              const Icon = ICON_BY_ID[target.id];
              return (
                <button
                  key={target.id}
                  type="button"
                  role="menuitem"
                  onClick={() => void dispatch(target.id)}
                  className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm text-text hover:bg-surface-raised"
                  style={isCopy ? { borderTop: '1px solid var(--color-border)' } : undefined}
                >
                  {Icon && (
                    <Icon size={14} className="shrink-0 text-text-secondary" aria-hidden="true" />
                  )}
                  <span className="flex-1">{labelOverride ?? target.label}</span>
                  {hint && (
                    <span className="text-[10px] uppercase tracking-wider text-text-muted">
                      {hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
