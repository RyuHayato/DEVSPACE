import { useCallback, useMemo, useRef } from 'react';
import { Pin, Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { Project } from '@/lib/types';
import { isProjectRunning, sortedProjects, useAppStore, type AppState } from '@/state/store';
import { Button } from './ui';

/** What the dot beside a project name means, in one place. */
function statusOf(state: AppState, project: Project) {
  if (isProjectRunning(state, project.id)) {
    return { className: 'dot dot--running', label: 'a command is running' };
  }
  const status = state.statuses[project.id];
  if (!status) return { className: 'dot dot--none', label: 'status not read yet' };
  if (!status.exists) return { className: 'dot dot--dirty', label: 'folder is missing' };
  if (!status.git.isRepo) return { className: 'dot dot--none', label: 'not a Git repository' };
  return status.git.clean
    ? { className: 'dot dot--clean', label: 'working tree clean' }
    : {
        className: 'dot dot--dirty',
        label: `${status.git.totalChanged} changed files`,
      };
}

function ProjectRow({ project }: { project: Project }) {
  const selected = useAppStore((s) => s.selectedId === project.id);
  // statusOf builds a fresh object, so the result is compared by value.
  const status = useAppStore(useShallow((s: AppState) => statusOf(s, project)));
  const selectProject = useAppStore((s) => s.selectProject);

  return (
    <li>
      <button
        type="button"
        className="project-row"
        aria-current={selected}
        data-project-row
        onClick={() => void selectProject(project.id)}
      >
        <span className={status.className} aria-hidden />
        <span className="project-row__name truncate">{project.name}</span>
        <span className="project-row__meta">
          {project.favorite ? (
            <span className="project-row__pin" aria-hidden>
              <Pin size={11} fill="currentColor" />
            </span>
          ) : null}
        </span>
        <span className="sr-only">
          {` — ${status.label}${project.favorite ? ', pinned' : ''}`}
        </span>
      </button>
    </li>
  );
}

function Group({ label, projects }: { label: string; projects: Project[] }) {
  if (projects.length === 0) return null;
  return (
    <div className="sidebar__group">
      <div className="sidebar__group-label">
        <span className="t-eyebrow">{label}</span>
      </div>
      <ul>
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} />
        ))}
      </ul>
    </div>
  );
}

export function Sidebar() {
  const projects = useAppStore(useShallow(sortedProjects));
  const pickAndAddProject = useAppStore((s) => s.pickAndAddProject);
  const listRef = useRef<HTMLElement>(null);

  const [pinned, rest] = useMemo(
    () => [projects.filter((p) => p.favorite), projects.filter((p) => !p.favorite)],
    [projects],
  );

  /** Up/Down move between projects; Home/End jump to the ends. */
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;

    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[data-project-row]') ?? [],
    );
    if (rows.length === 0) return;

    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : Math.min(current + 1, rows.length - 1);
        break;
      case 'ArrowUp':
        next = current < 0 ? rows.length - 1 : Math.max(current - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      default:
        next = rows.length - 1;
    }
    event.preventDefault();
    rows[next]?.focus();
  }, []);

  return (
    <aside className="sidebar" id="project-sidebar">
      <div className="sidebar__head">
        <h2 className="t-eyebrow">Projects</h2>
        <span className="sidebar__count">{projects.length}</span>
      </div>

      <nav className="sidebar__list" ref={listRef} onKeyDown={onKeyDown} aria-label="Projects">
        {projects.length === 0 ? (
          <p className="t-meta" style={{ padding: 'var(--s-4) var(--s-5)' }}>
            No projects yet.
          </p>
        ) : (
          <>
            <Group label="Pinned" projects={pinned} />
            <Group label={pinned.length > 0 ? 'All projects' : 'Projects'} projects={rest} />
          </>
        )}
      </nav>

      <div className="sidebar__foot">
        <Button block onClick={() => void pickAndAddProject()}>
          <Plus size={14} aria-hidden />
          Add project
        </Button>
      </div>
    </aside>
  );
}
