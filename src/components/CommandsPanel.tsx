import { useState } from 'react';
import { Pencil, Play, Plus, ScanLine, Square, Terminal, Trash2 } from 'lucide-react';
import type { CommandDef, CommandKind, Project } from '@/lib/types';
import { runsForProject, useAppStore, type AppState } from '@/state/store';
import { Button, EmptyState, Field } from './ui';
import { Dialog } from './Dialog';

const KINDS: Array<{ value: CommandKind; label: string }> = [
  { value: 'dev', label: 'Dev' },
  { value: 'test', label: 'Test' },
  { value: 'build', label: 'Build' },
  { value: 'lint', label: 'Check' },
  { value: 'install', label: 'Install' },
  { value: 'custom', label: 'Custom' },
];

/** Add/edit form. The exact command line is always visible before it runs. */
function CommandDialog({
  projectId,
  projectPath,
  existing,
  onClose,
}: {
  projectId: string;
  projectPath: string;
  existing: CommandDef | null;
  onClose(): void;
}) {
  const addCommand = useAppStore((s) => s.addCommand);
  const updateCommand = useAppStore((s) => s.updateCommand);

  const [label, setLabel] = useState(existing?.label ?? '');
  const [program, setProgram] = useState(existing?.program ?? '');
  const [kind, setKind] = useState<CommandKind>(existing?.kind ?? 'custom');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!program.trim()) {
      setError('Enter the command to run, for example `npm test`.');
      return;
    }
    setError(null);
    setSaving(true);
    const ok = existing
      ? await updateCommand(projectId, existing.id, label, program, kind)
      : await addCommand(projectId, label, program, kind);
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <Dialog
      title={existing ? 'Edit command' : 'Add command'}
      description="Runs in the project folder through your system shell."
      onClose={onClose}
      footer={
        <>
          <div className="dialog__foot-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" busy={saving} onClick={() => void submit()}>
            {existing ? 'Save command' : 'Add command'}
          </Button>
        </>
      }
    >
      <Field label="Name" hint="optional" htmlFor="command-label">
        <input
          id="command-label"
          className="input"
          data-autofocus
          value={label}
          placeholder="Test"
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>

      <Field label="Command" htmlFor="command-program" error={error ?? undefined}>
        <input
          id="command-program"
          className="input input--mono"
          value={program}
          placeholder="npm test"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'command-program-error' : undefined}
          onChange={(event) => {
            setProgram(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </Field>

      <Field label="Kind" hint="groups it in the palette" htmlFor="command-kind">
        <select
          id="command-kind"
          className="input"
          value={kind}
          onChange={(event) => setKind(event.target.value as CommandKind)}
        >
          {KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <p className="t-meta">
        Working directory: <code className="t-mono">{projectPath}</code>
      </p>
    </Dialog>
  );
}

function CommandRow({
  project,
  command,
  onEdit,
}: {
  project: Project;
  command: CommandDef;
  onEdit(command: CommandDef): void;
}) {
  const run = useAppStore((s) => s.runCommand);
  const cancel = useAppStore((s) => s.cancelRun);
  const removeCommand = useAppStore((s) => s.removeCommand);
  const starting = useAppStore((s) => s.busy[`run:${project.id}`] === true);

  // A command is "running" when a live run in this project shares its line.
  const activeRun = useAppStore((state: AppState) =>
    runsForProject(state, project.id).find(
      (candidate) => candidate.status === 'running' && candidate.command === command.program,
    ),
  );
  const running = Boolean(activeRun);

  return (
    <li className={`command-row${running ? ' command-row--running' : ''}`}>
      <button
        type="button"
        className="command-row__run"
        disabled={starting && !running}
        onClick={() =>
          running && activeRun
            ? void cancel(activeRun.runId)
            : void run(project.id, command.label, command.program)
        }
        aria-label={
          running ? `Stop ${command.label}` : `Run ${command.label}: ${command.program}`
        }
      >
        {running ? (
          <Square size={11} fill="currentColor" aria-hidden />
        ) : (
          <Play size={12} fill="currentColor" aria-hidden />
        )}
      </button>

      <span className="command-row__text">
        <span className="command-row__label truncate">{command.label}</span>
        <span className="command-row__program truncate" title={command.program}>
          {command.program}
        </span>
      </span>

      <span className="command-row__actions">
        <Button
          variant="ghost"
          icon
          size="sm"
          onClick={() => onEdit(command)}
          aria-label={`Edit ${command.label}`}
        >
          <Pencil size={12} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          icon
          size="sm"
          onClick={() => void removeCommand(project.id, command.id)}
          aria-label={`Remove ${command.label}`}
        >
          <Trash2 size={12} aria-hidden />
        </Button>
      </span>
    </li>
  );
}

export function CommandsPanel({ project }: { project: Project }) {
  const syncDetected = useAppStore((s) => s.syncDetectedCommands);
  const [dialog, setDialog] = useState<{ open: boolean; editing: CommandDef | null }>({
    open: false,
    editing: null,
  });

  const sorted = [...project.commands].sort((a, b) => {
    const order = KINDS.map((k) => k.value);
    return order.indexOf(a.kind) - order.indexOf(b.kind);
  });

  return (
    <section className="panel" aria-labelledby="commands-heading">
      <header className="panel__head">
        <h2 className="t-eyebrow" id="commands-heading">
          Commands
        </h2>
        <div className="panel__head-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void syncDetected(project.id)}
            title="Look for commands this project defines"
          >
            <ScanLine size={13} aria-hidden />
            Re-scan
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDialog({ open: true, editing: null })}
          >
            <Plus size={13} aria-hidden />
            Add
          </Button>
        </div>
      </header>

      <div className="panel__body">
        {sorted.length === 0 ? (
          <EmptyState
            variant="inline"
            icon={Terminal}
            title="No commands configured"
            body="Re-scan to pick up the scripts this project defines, or add one by hand."
            actions={
              <>
                <Button size="sm" onClick={() => void syncDetected(project.id)}>
                  Re-scan project
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDialog({ open: true, editing: null })}
                >
                  Add manually
                </Button>
              </>
            }
          />
        ) : (
          <ul className="command-list">
            {sorted.map((command) => (
              <CommandRow
                key={command.id}
                project={project}
                command={command}
                onEdit={(editing) => setDialog({ open: true, editing })}
              />
            ))}
          </ul>
        )}
      </div>

      {dialog.open ? (
        <CommandDialog
          projectId={project.id}
          projectPath={project.path}
          existing={dialog.editing}
          onClose={() => setDialog({ open: false, editing: null })}
        />
      ) : null}
    </section>
  );
}
