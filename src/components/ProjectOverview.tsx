import { useCallback } from 'react';
import {
  Copy,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  Github,
  Hammer,
  Pin,
  PinOff,
  Play,
  SlidersHorizontal,
  SquareTerminal,
  TerminalSquare,
  TestTube2,
} from 'lucide-react';
import { ecosystemLabel, relativeTime, shortenPath } from '@/lib/format';
import type { CommandKind, Project, ProjectStatus } from '@/lib/types';
import { activeRunForProject, useAppStore, type AppState } from '@/state/store';
import { ActivityPanel } from './ActivityPanel';
import { CommandsPanel } from './CommandsPanel';
import { GitPanel } from './GitPanel';
import { Badge, Button, Notice, Skeleton } from './ui';

function Stat({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: 'muted' | 'accent' | 'warning';
}) {
  return (
    <div className="stat">
      <span className="t-eyebrow">{label}</span>
      <span className={`stat__value${tone ? ` stat__value--${tone}` : ''}`}>
        <span className="t-stat">{value}</span>
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </span>
    </div>
  );
}

function Stats({ project, status }: { project: Project; status: ProjectStatus | undefined }) {
  const history = useAppStore((s) => s.workspace.history);
  const git = status?.git;
  const lastRun = history.find((entry) => entry.projectId === project.id);

  return (
    <div className="stats">
      <Stat
        label="Branch"
        value={
          git?.isRepo
            ? (git.branch ?? (git.detached ? 'detached' : '—'))
            : git?.available === false
              ? 'n/a'
              : '—'
        }
        tone={git?.isRepo ? undefined : 'muted'}
      />
      <Stat
        label="Changed"
        value={git?.isRepo ? git.totalChanged : '—'}
        unit={git?.isRepo && git.totalChanged > 0 ? 'files' : undefined}
        tone={!git?.isRepo ? 'muted' : git.totalChanged > 0 ? 'warning' : undefined}
      />
      <Stat
        label="Ahead / behind"
        value={git?.isRepo ? `${git.ahead}/${git.behind}` : '—'}
        tone={git?.isRepo && (git.ahead > 0 || git.behind > 0) ? 'accent' : 'muted'}
      />
      <Stat
        label="Commands"
        value={project.commands.length}
        tone={project.commands.length ? undefined : 'muted'}
      />
      <Stat
        label="Last run"
        value={lastRun ? relativeTime(lastRun.at) : '—'}
        tone={lastRun ? undefined : 'muted'}
      />
    </div>
  );
}

/** Only actions that can actually succeed on this machine are offered. */
function QuickActions({ project }: { project: Project }) {
  const quickAction = useAppStore((s) => s.quickAction);
  const runCommand = useAppStore((s) => s.runCommand);
  const editors = useAppStore((s) => s.editors);
  const editorId = useAppStore((s) => s.workspace.settings.editor);
  const customEditor = useAppStore((s) => s.workspace.settings.customEditorCommand);
  const native = useAppStore((s) => s.client.native);
  const busy = useAppStore((s) => s.busy);

  const editor = editors.find((candidate) => candidate.id === editorId);
  const editorAvailable =
    !native || editorId === 'custom'
      ? Boolean(customEditor) || !native
      : (editor?.available ?? false);
  const editorLabel =
    editorId === 'custom' ? 'Open in editor' : `Open in ${editor?.label ?? 'editor'}`;

  const byKind = (kind: CommandKind) =>
    project.commands.find((command) => command.kind === kind);
  const dev = byKind('dev');
  const test = byKind('test');
  const build = byKind('build');

  return (
    <div className="actions">
      {dev ? (
        <Button
          variant="accent"
          onClick={() => void runCommand(project.id, dev.label, dev.program)}
        >
          <Play size={13} fill="currentColor" aria-hidden />
          {dev.label}
        </Button>
      ) : null}
      {test ? (
        <Button onClick={() => void runCommand(project.id, test.label, test.program)}>
          <TestTube2 size={14} aria-hidden />
          {test.label}
        </Button>
      ) : null}
      {build ? (
        <Button onClick={() => void runCommand(project.id, build.label, build.program)}>
          <Hammer size={14} aria-hidden />
          {build.label}
        </Button>
      ) : null}

      {editorAvailable ? (
        <Button
          busy={busy[`action:editor:${project.id}`] === true}
          onClick={() => void quickAction('editor', project.id)}
        >
          <SquareTerminal size={14} aria-hidden />
          {editorLabel}
        </Button>
      ) : null}

      <Button
        busy={busy[`action:folder:${project.id}`] === true}
        onClick={() => void quickAction('folder', project.id)}
      >
        <FolderOpen size={14} aria-hidden />
        Folder
      </Button>
      <Button
        busy={busy[`action:terminal:${project.id}`] === true}
        onClick={() => void quickAction('terminal', project.id)}
      >
        <TerminalSquare size={14} aria-hidden />
        Terminal
      </Button>

      {project.repositoryUrl ? (
        <Button
          busy={busy[`action:repository:${project.id}`] === true}
          onClick={() => void quickAction('repository', project.id)}
        >
          <Github size={14} aria-hidden />
          Repository
          <ExternalLink size={11} aria-hidden style={{ opacity: 0.5 }} />
        </Button>
      ) : null}
    </div>
  );
}

export function ProjectOverview({ project }: { project: Project }) {
  const status = useAppStore(
    useCallback((s: AppState) => s.statuses[project.id], [project.id]),
  );
  const loading = useAppStore(
    useCallback((s: AppState) => s.statusPending[project.id] === true, [project.id]),
  );
  const statusError = useAppStore(
    useCallback((s: AppState) => s.statusErrors[project.id], [project.id]),
  );
  const running = useAppStore(
    useCallback((s: AppState) => activeRunForProject(s, project.id), [project.id]),
  );
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const editProject = useAppStore((s) => s.editProject);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const toast = useAppStore((s) => s.toast);

  const detection = status?.detection;

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(project.path);
      toast({ level: 'success', title: 'Path copied' });
    } catch {
      toast({
        level: 'error',
        title: 'Could not copy the path',
        hint: 'Your system denied clipboard access.',
      });
    }
  }

  return (
    <div className="overview">
      <div className="overview__inner">
        <header className="project-head">
          <div className="project-head__kicker">
            {detection?.projectType ? <Badge>{detection.projectType}</Badge> : null}
            {detection?.ecosystems.map((eco) => (
              <Badge key={eco}>{ecosystemLabel(eco)}</Badge>
            ))}
            {detection?.packageManager ? <Badge>{detection.packageManager}</Badge> : null}
            {running ? <Badge tone="accent">running {running.label}</Badge> : null}
            {!detection && loading ? <Skeleton width="180px" height={19} /> : null}
          </div>

          <div className="project-head__title-row">
            <h1 className="t-display project-head__title">{project.name}</h1>
            <div className="project-head__tools">
              <Button
                variant="ghost"
                icon
                size="sm"
                onClick={() => void toggleFavorite(project.id)}
                aria-pressed={project.favorite}
                aria-label={project.favorite ? 'Unpin project' : 'Pin project'}
              >
                {project.favorite ? (
                  <PinOff size={14} aria-hidden />
                ) : (
                  <Pin size={14} aria-hidden />
                )}
              </Button>
              <Button
                variant="ghost"
                icon
                size="sm"
                onClick={() => editProject(project.id)}
                aria-label="Project settings"
              >
                <SlidersHorizontal size={14} aria-hidden />
              </Button>
            </div>
          </div>

          <div className="project-head__path">
            <code title={project.path}>{shortenPath(project.path, 3)}</code>
            <Button
              variant="ghost"
              icon
              size="sm"
              onClick={() => void copyPath()}
              aria-label="Copy full path"
            >
              <Copy size={12} aria-hidden />
            </Button>
          </div>
        </header>

        {statusError ? (
          <Notice
            level="error"
            title="Could not read this project's status."
            detail={statusError.message}
            hint={statusError.hint}
            actions={
              <Button size="sm" onClick={() => void refreshStatus(project.id, { force: true })}>
                Try again
              </Button>
            }
          />
        ) : null}

        {status && !status.exists ? (
          <Notice
            level="error"
            title={status.error?.message ?? 'This folder is no longer there.'}
            hint={status.error?.hint}
            actions={
              <>
                <Button size="sm" onClick={() => editProject(project.id)}>
                  <FolderSearch size={13} aria-hidden />
                  Update path
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void refreshStatus(project.id, { force: true })}
                >
                  Check again
                </Button>
              </>
            }
          />
        ) : null}

        <Stats project={project} status={status} />

        {status?.exists !== false ? <QuickActions project={project} /> : null}

        <div className="panels">
          <GitPanel status={status} loading={loading} projectId={project.id} />
          <CommandsPanel project={project} />
        </div>

        <ActivityPanel projectId={project.id} />
      </div>
    </div>
  );
}
