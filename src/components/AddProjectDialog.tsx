/**
 * Add a project by typing its path.
 *
 * The native build opens the system folder picker instead; this dialog is the
 * fallback for the browser preview, and the way to add a path the picker
 * cannot reach (a network share, a symlinked checkout).
 */

import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useAppStore } from '@/state/store';
import { Dialog } from './Dialog';
import { Button, Field, Notice } from './ui';

export function AddProjectDialog() {
  const closeOverlay = useAppStore((s) => s.closeOverlay);
  const addProject = useAppStore((s) => s.addProject);
  const native = useAppStore((s) => s.client.native);
  const pickDirectory = useAppStore((s) => s.client.pickDirectory);
  const toastError = useAppStore((s) => s.toastError);

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const trimmed = path.trim();
    if (!trimmed) {
      setError('Enter the full path to the project folder.');
      return;
    }

    setError(null);
    setSaving(true);
    // addProject reports its own failure as a toast and closes the dialog on
    // success, so there is nothing left to do here but stop the spinner.
    const added = await addProject(trimmed, name.trim() || undefined);
    if (!added) setSaving(false);
  }

  async function browse() {
    try {
      const picked = await pickDirectory();
      if (picked) {
        setPath(picked);
        setError(null);
      }
    } catch (thrown) {
      toastError('Could not open the folder picker', thrown);
    }
  }

  return (
    <Dialog
      title="Add project"
      description="DevWorkspace reads this folder. It never moves or modifies it."
      onClose={closeOverlay}
      footer={
        <>
          <div className="dialog__foot-spacer" />
          <Button variant="ghost" onClick={closeOverlay}>
            Cancel
          </Button>
          <Button variant="accent" busy={saving} onClick={() => void submit()}>
            Add project
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Project folder"
          hint="absolute path"
          htmlFor="add-project-path"
          error={error ?? undefined}
        >
          <input
            id="add-project-path"
            className="input input--mono"
            data-autofocus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={
              native ? 'C:\\Users\\you\\code\\my-project' : '/Users/you/code/my-project'
            }
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'add-project-path-error' : undefined}
          />
        </Field>

        {native ? (
          <div style={{ marginBottom: 'var(--s-6)' }}>
            <Button size="sm" onClick={() => void browse()}>
              <FolderOpen size={13} aria-hidden />
              Browse…
            </Button>
          </div>
        ) : null}

        <Field
          label="Display name"
          hint="optional — defaults to the folder name"
          htmlFor="add-project-name"
        >
          <input
            id="add-project-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My project"
            autoComplete="off"
          />
        </Field>

        {/* Submits the form without a visible second button. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          Add project
        </button>
      </form>

      {!native ? (
        <Notice
          level="warn"
          title="Browser preview"
          detail="Any path is accepted here and its contents are simulated."
          hint="Run `npm run app` to add real folders from disk."
        />
      ) : null}
    </Dialog>
  );
}
