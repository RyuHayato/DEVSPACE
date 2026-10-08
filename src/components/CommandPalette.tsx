/**
 * The command palette.
 *
 * A single ranked list over projects, their commands, and app actions. It
 * follows the combobox pattern: the input keeps focus and owns the keyboard,
 * while `aria-activedescendant` tells assistive technology which row is
 * current.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  CornerDownLeft,
  FolderOpen,
  Github,
  Play,
  Plus,
  Search,
  Settings2,
  SquareTerminal,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { highlight, rankItems } from '@/lib/fuzzy';
import { shortenPath } from '@/lib/format';
import { sortedProjects, useAppStore } from '@/state/store';
import { useFocusTrap } from './Dialog';
import { Kbd } from './ui';

type Group = 'Projects' | 'Commands' | 'Actions';

interface PaletteItem {
  id: string;
  group: Group;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  run(): void;
}

export function CommandPalette() {
  const closeOverlay = useAppStore((s) => s.closeOverlay);
  const openOverlay = useAppStore((s) => s.openOverlay);
  const projects = useAppStore(useShallow(sortedProjects));
  const selectedId = useAppStore((s) => s.selectedId);
  const selectProject = useAppStore((s) => s.selectProject);
  const runCommand = useAppStore((s) => s.runCommand);
  const quickAction = useAppStore((s) => s.quickAction);
  const pickAndAddProject = useAppStore((s) => s.pickAndAddProject);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const onKeyDownTrap = useFocusTrap(container, true, closeOverlay);
  const current = projects.find((project) => project.id === selectedId) ?? null;

  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];

    for (const project of projects) {
      result.push({
        id: `project:${project.id}`,
        group: 'Projects',
        title: project.name,
        subtitle: shortenPath(project.path, 2),
        icon: FolderOpen,
        run: () => void selectProject(project.id),
      });
    }

    // Commands for the selected project are the ones a user wants mid-flow.
    if (current) {
      for (const command of current.commands) {
        result.push({
          id: `command:${command.id}`,
          group: 'Commands',
          title: `${command.label} — ${current.name}`,
          subtitle: command.program,
          icon: Play,
          run: () => void runCommand(current.id, command.label, command.program),
        });
      }
      result.push(
        {
          id: 'action:editor',
          group: 'Actions',
          title: `Open ${current.name} in editor`,
          icon: SquareTerminal,
          run: () => void quickAction('editor', current.id),
        },
        {
          id: 'action:folder',
          group: 'Actions',
          title: `Open ${current.name} folder`,
          icon: FolderOpen,
          run: () => void quickAction('folder', current.id),
        },
        {
          id: 'action:terminal',
          group: 'Actions',
          title: `Open terminal in ${current.name}`,
          icon: TerminalSquare,
          run: () => void quickAction('terminal', current.id),
        },
      );
      if (current.repositoryUrl) {
        result.push({
          id: 'action:repository',
          group: 'Actions',
          title: `Open ${current.name} repository`,
          subtitle: current.repositoryUrl,
          icon: Github,
          run: () => void quickAction('repository', current.id),
        });
      }
    }

    result.push(
      {
        id: 'action:add',
        group: 'Actions',
        title: 'Add project…',
        icon: Plus,
        run: () => void pickAndAddProject(),
      },
      {
        id: 'action:settings',
        group: 'Actions',
        title: 'Open settings',
        icon: Settings2,
        run: () => openOverlay('settings'),
      },
    );

    return result;
  }, [
    projects,
    current,
    selectProject,
    runCommand,
    quickAction,
    pickAndAddProject,
    openOverlay,
  ]);

  const results = useMemo(() => {
    const ranked = rankItems(query, items, (item) => [item.title, item.subtitle ?? '']);
    return ranked.slice(0, 40);
  }, [query, items]);

  // Any change to the result set resets the cursor to the best match.
  useEffect(() => {
    setActive(0);
  }, [query]);

  const activeItem = results[active];
  const activeOptionId = activeItem ? `${baseId}-${activeItem.item.id}` : undefined;

  // Keep the highlighted row in view without animating the whole list.
  useEffect(() => {
    if (!activeOptionId) return;
    listRef.current
      ?.querySelector(`[id="${CSS.escape(activeOptionId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

  const choose = useCallback(
    (index: number) => {
      const chosen = results[index];
      if (!chosen) return;
      closeOverlay();
      chosen.item.run();
    },
    [results, closeOverlay],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActive((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setActive((index) =>
            results.length === 0 ? 0 : (index - 1 + results.length) % results.length,
          );
          return;
        case 'Home':
          event.preventDefault();
          setActive(0);
          return;
        case 'End':
          event.preventDefault();
          setActive(Math.max(0, results.length - 1));
          return;
        case 'Enter':
          event.preventDefault();
          choose(active);
          return;
        default:
          onKeyDownTrap(event);
      }
    },
    [results.length, active, choose, onKeyDownTrap],
  );

  // Group headings are rendered inline, before the first row of each group.
  let lastGroup: Group | null = null;

  return (
    <div
      className="scrim scrim--top"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeOverlay();
      }}
    >
      <div
        className="palette"
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label="Search projects and commands"
        onKeyDown={onKeyDown}
      >
        <div className="palette__input-row">
          <Search size={16} aria-hidden style={{ color: 'var(--text-faint)', flex: 'none' }} />
          <input
            className="palette__input"
            data-autofocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects, commands and actions"
            role="combobox"
            aria-expanded
            aria-controls={`${baseId}-list`}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            aria-label="Search projects, commands and actions"
          />
        </div>

        <div className="palette__results" ref={listRef}>
          <div role="listbox" id={`${baseId}-list`} aria-label="Results">
            {results.length === 0 ? (
              <p className="t-meta" style={{ padding: 'var(--s-6) var(--s-5)' }}>
                Nothing matches “{query}”. Try a project name, a command, or “settings”.
              </p>
            ) : (
              results.map((result, index) => {
                const item = result.item;
                const Icon = item.icon;
                const heading = item.group !== lastGroup ? item.group : null;
                lastGroup = item.group;
                const segments = highlight(item.title, result.indices);

                return (
                  <div key={item.id}>
                    {heading ? (
                      <div className="palette__group-label t-eyebrow">{heading}</div>
                    ) : null}
                    <div
                      id={`${baseId}-${item.id}`}
                      role="option"
                      aria-selected={index === active}
                      className="palette__item"
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(index)}
                    >
                      <Icon size={14} aria-hidden style={{ color: 'var(--text-muted)' }} />
                      <span className="palette__item-text">
                        <span className="palette__item-title truncate">
                          {segments.map((segment, i) =>
                            segment.match ? (
                              <mark key={i}>{segment.text}</mark>
                            ) : (
                              <span key={i}>{segment.text}</span>
                            ),
                          )}
                        </span>
                        {item.subtitle ? (
                          <span className="palette__item-sub truncate">{item.subtitle}</span>
                        ) : null}
                      </span>
                      {index === active ? (
                        <CornerDownLeft
                          size={13}
                          aria-hidden
                          style={{ color: 'var(--accent)' }}
                        />
                      ) : (
                        <span />
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="palette__foot">
          <span className="palette__hint">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            navigate
          </span>
          <span className="palette__hint">
            <Kbd>↵</Kbd>
            run
          </span>
          <span className="palette__hint">
            <Kbd>Esc</Kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
