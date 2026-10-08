/**
 * The application shell.
 *
 * Owns the three things that are genuinely global: the boot sequence, the
 * appearance attributes on `<html>`, and the keyboard shortcuts. Everything
 * else is a panel that reads what it needs from the store.
 */

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, FolderPlus, MousePointerClick, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { ActivityPanel } from './components/ActivityPanel';
import { AddProjectDialog } from './components/AddProjectDialog';
import { CommandPalette } from './components/CommandPalette';
import { OutputPanel } from './components/OutputPanel';
import { ProjectOverview } from './components/ProjectOverview';
import { ProjectSettingsDialog } from './components/ProjectSettingsDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toasts';
import { Topbar } from './components/Topbar';
import { Button, EmptyState, Notice, Spinner } from './components/ui';
import { modifierKey } from '@/lib/format';
import { selectedProject, sortedProjects, useAppStore } from '@/state/store';

/** Below this the sidebar becomes an overlay drawer rather than a column. */
const WIDE_QUERY = '(min-width: 820px)';

function isWide() {
  return typeof window === 'undefined' ? true : window.matchMedia(WIDE_QUERY).matches;
}

function Boot() {
  return (
    <div className="boot">
      <div className="boot__inner">
        <span className="boot__mark" aria-hidden>
          ›_
        </span>
        <p className="t-meta" role="status">
          <Spinner size={13} /> Reading your workspace…
        </p>
      </div>
    </div>
  );
}

function BootFailure() {
  const bootError = useAppStore((s) => s.bootError);
  const bootstrap = useAppStore((s) => s.bootstrap);

  return (
    <div className="boot">
      <div className="boot__inner" style={{ textAlign: 'left' }}>
        <Notice
          level="error"
          title="DevWorkspace could not open your workspace."
          detail={bootError?.message}
          hint={
            bootError?.hint ??
            'Your projects are stored in one JSON file; it may be unreadable.'
          }
          actions={
            <Button size="sm" onClick={() => void bootstrap()}>
              <RefreshCw size={13} aria-hidden />
              Try again
            </Button>
          }
        />
      </div>
    </div>
  );
}

/** Shown in place of the overview when there is nothing to show yet. */
function MainPlaceholder() {
  const projects = useAppStore(useShallow(sortedProjects));
  const pickAndAddProject = useAppStore((s) => s.pickAndAddProject);
  const selectProject = useAppStore((s) => s.selectProject);
  const modifier = modifierKey();

  return (
    <div className="overview">
      <div className="overview__inner">
        {projects.length === 0 ? (
          <EmptyState
            icon={FolderPlus}
            variant="center"
            title="No projects yet"
            body="Add a folder from your machine. DevWorkspace reads its Git state, detects how it is built, and gives you its commands in one place."
            actions={
              <Button variant="accent" onClick={() => void pickAndAddProject()}>
                <FolderPlus size={14} aria-hidden />
                Add your first project
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={MousePointerClick}
            variant="center"
            title="Nothing selected"
            body={`Pick a project from the list, or press ${modifier}+K to search.`}
            actions={
              <Button onClick={() => void selectProject(projects[0]?.id ?? null)}>
                Open {projects[0]?.name}
              </Button>
            }
          />
        )}

        <ActivityPanel projectId={null} />
      </div>
    </div>
  );
}

export function App() {
  const phase = useAppStore((s) => s.phase);
  const bootstrap = useAppStore((s) => s.bootstrap);
  const settings = useAppStore((s) => s.workspace.settings);
  const overlay = useAppStore((s) => s.overlay);
  const openOverlay = useAppStore((s) => s.openOverlay);
  const selectedId = useAppStore((s) => s.selectedId);
  const project = useAppStore(selectedProject);
  const projectIds = useAppStore(useShallow((s) => sortedProjects(s).map((p) => p.id)));
  const selectProject = useAppStore((s) => s.selectProject);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const native = useAppStore((s) => s.client.native);

  const [sidebarOpen, setSidebarOpen] = useState(isWide);

  // --- appearance --------------------------------------------------------

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.accent = settings.accent;
    root.dataset.density = settings.density;
    // 'system' is a real value here: the stylesheet pairs it with a
    // prefers-reduced-motion query rather than resolving it in JavaScript.
    root.dataset.motion = settings.motion;
  }, [settings.theme, settings.accent, settings.density, settings.motion]);

  // --- boot --------------------------------------------------------------

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // --- responsive sidebar ------------------------------------------------

  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const apply = (event: MediaQueryListEvent) => setSidebarOpen(event.matches);
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  // On a narrow window the sidebar covers the content, so choosing a project
  // should get out of the way.
  useEffect(() => {
    if (!isWide()) setSidebarOpen(false);
  }, [selectedId]);

  // --- background status refresh -----------------------------------------

  useEffect(() => {
    const seconds = settings.statusRefreshSeconds;
    if (!selectedId || seconds <= 0) return;

    const timer = window.setInterval(() => {
      // No point reading a working tree nobody is looking at.
      if (document.hidden) return;
      void refreshStatus(selectedId, { force: true });
    }, seconds * 1000);

    return () => window.clearInterval(timer);
  }, [selectedId, settings.statusRefreshSeconds, refreshStatus]);

  // --- keyboard ----------------------------------------------------------

  const onWindowKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey) return;

      const key = event.key;

      if (key === 'k' || key === 'K') {
        event.preventDefault();
        openOverlay(overlay === 'palette' ? null : 'palette');
        return;
      }
      if (key === 'b' || key === 'B') {
        event.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      if (key === ',') {
        event.preventDefault();
        openOverlay('settings');
        return;
      }
      // Jump straight to a project by position, as a tabbed app would.
      if (key >= '1' && key <= '9' && !event.shiftKey) {
        const target = projectIds[Number(key) - 1];
        if (!target) return;
        event.preventDefault();
        void selectProject(target);
      }
    },
    [overlay, openOverlay, projectIds, selectProject],
  );

  useEffect(() => {
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [onWindowKeyDown]);

  // --- render ------------------------------------------------------------

  if (phase === 'failed') return <BootFailure />;

  return (
    <div className="app">
      {native ? null : (
        <div className="preview-banner" role="status">
          <FlaskConical size={13} aria-hidden style={{ flex: 'none' }} />
          <span>
            Browser preview — projects, Git state and command output are simulated. Run{' '}
            <code>npm run app</code> for the real thing.
          </span>
        </div>
      )}

      {phase === 'loading' ? (
        <Boot />
      ) : (
        <div className="shell" data-sidebar={sidebarOpen ? 'expanded' : 'collapsed'}>
          <Topbar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((open) => !open)}
          />

          <div className="shell__body">
            <Sidebar />
            <div
              className="sidebar-scrim"
              onMouseDown={() => setSidebarOpen(false)}
              aria-hidden
            />

            <main className="main">
              {project ? <ProjectOverview project={project} /> : <MainPlaceholder />}
              <OutputPanel projectId={selectedId} />
            </main>
          </div>
        </div>
      )}

      {overlay === 'palette' ? <CommandPalette /> : null}
      {overlay === 'settings' ? <SettingsDialog /> : null}
      {overlay === 'addProject' ? <AddProjectDialog /> : null}
      {overlay === 'projectSettings' ? <ProjectSettingsDialog /> : null}

      <Toasts />
    </div>
  );
}
