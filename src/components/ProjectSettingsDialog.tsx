/**
 * Per-project settings: display name, folder, repository URL, and removal.
 *
 * Commands are edited in the project's own Commands panel, so they are
 * deliberately absent here.
 */

import { useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { useAppStore } from '@/state/store';
import { Dialog } from './Dialog';
import { Button, Field, Notice } from './ui';

/** Accepts what a developer would actually paste, and nothing else. */
function repositoryError(value: string): string | null {
  if (!value) return null;
  if (/^git@[\w.-]+:.+/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return null;
    return 'Use an https:// address or an SSH remote.';
  } catch {
    return 'That does not look like a repository address.';
  }
}

export function ProjectSettingsDialog() {
  const closeOverlay = useAppStore((s) => s.closeOverlay);
  const project = useAppStore((s) =>
    s.workspace.projects.find((p) => p.id === s.editingProjectId),
  );
  const updateProject = useAppStore((s) => s.updateProject);
  const removeProject = useAppStore((s) => s.removeProject);
  const native = useAppStore((s) => s.client.native);
  const pickDirectory = useAppStore((s) => s.client.pickDirectory);
  const toastError = useAppStore((s) => s.toastError);
  const toast = useAppStore((s) => s.toast);

  const [name, setName] = useState(project?.name ?? '');
  const [path, setPath] = useState(project?.path ?? '');
  const [repository, setRepository] = useState(project?.repositoryUrl ?? '');
  const [errors, setErrors] = useState<{ name?: string; path?: string; repository?: string }>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // The project can disappear while this is open — a removal from the palette,
  // or a workspace change pushed from the backend.
  if (!project) {
    return (
      <Dialog
        title="Project settings"
        onClose={closeOverlay}
        footer={
          <>
            <div className="dialog__foot-spacer" />
            <Button variant="accent" onClick={closeOverlay}>
              Close
            </Button>
          </>
        }
      >
        <Notice
          level="info"
          title="This project is no longer in your workspace."
          hint="It was removed while these settings were open."
        />
      </Dialog>
    );
  }

  async function save() {
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    const trimmedRepository = repository.trim();

    const next: typeof errors = {};
    if (!trimmedName) next.name = 'A project needs a name.';
    if (!trimmedPath) next.path = 'Enter the folder this project lives in.';
    const repositoryProblem = repositoryError(trimmedRepository);
    if (repositoryProblem) next.repository = repositoryProblem;

    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (!project) return;

    setSaving(true);
    const saved = await updateProject(project.id, {
      name: trimmedName,
      path: trimmedPath,
      repositoryUrl: trimmedRepository || null,
    });
    setSaving(false);

    if (saved) {
      toast({ level: 'success', title: `${trimmedName} updated` });
      closeOverlay();
    }
  }

  async function browse() {
    try {
      const picked = await pickDirectory();
      if (picked) {
        setPath(picked);
        setErrors((previous) => ({ ...previous, path: undefined }));
      }
    } catch (thrown) {
      toastError('Could not open the folder picker', thrown);
    }
  }

  return (
    <Dialog
      title="Project settings"
      description={project.name}
      onClose={closeOverlay}
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => setConfirmingRemove(true)}
            aria-expanded={confirmingRemove}
          >
            <Trash2 size={13} aria-hidden />
            Remove
          </Button>
          <div className="dialog__foot-spacer" />
          <Button variant="ghost" onClick={closeOverlay}>
            Cancel
          </Button>
          <Button variant="accent" busy={saving} onClick={() => void save()}>
            Save changes
          </Button>
        </>
      }
    >
      {confirmingRemove ? (
        <Notice
          level="warn"
          title={`Remove ${project.name} from DevWorkspace?`}
          detail="Its configured commands and history go with it."
          hint="The folder and its contents on disk are not touched."
          actions={
            <>
              <Button
                size="sm"
                variant="danger"
                data-autofocus
                onClick={() => void removeProject(project.id)}
              >
                Remove project
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
                Keep it
              </Button>
            </>
          }
        />
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Display name" htmlFor="project-name" error={errors.name}>
          <input
            id="project-name"
            className="input"
            data-autofocus={confirmingRemove ? undefined : true}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            aria-invalid={errors.name ? true : undefined}
          />
        </Field>

        <Field
          label="Folder"
          hint="where commands run"
          htmlFor="project-path"
          error={errors.path}
        >
          <input
            id="project-path"
            className="input input--mono"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={errors.path ? true : undefined}
          />
        </Field>

        {native ? (
          <div style={{ marginBottom: 'var(--s-6)' }}>
            <Button size="sm" onClick={() => void browse()}>
              <FolderOpen size={13} aria-hidden />
              Choose folder…
            </Button>
          </div>
        ) : null}

        <Field
          label="Repository"
          hint="optional — enables the Repository action"
          htmlFor="project-repository"
          error={errors.repository}
        >
          <input
            id="project-repository"
            className="input input--mono"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="https://github.com/you/project"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={errors.repository ? true : undefined}
          />
        </Field>

        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          Save changes
        </button>
      </form>
    </Dialog>
  );
}
