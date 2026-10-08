import { useEffect } from 'react';
import { FolderOpen, HardDrive } from 'lucide-react';
import { formatBytes } from '@/lib/format';
import type { Accent, Density, MotionPref, Theme } from '@/lib/types';
import { useAppStore } from '@/state/store';
import { Dialog } from './Dialog';
import { Button, Field, Notice, Segmented, Switch } from './ui';

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'midnight', label: 'Midnight' },
  { value: 'graphite', label: 'Graphite' },
];

const ACCENTS: Array<{ value: Accent; label: string }> = [
  { value: 'ember', label: 'Ember' },
  { value: 'sage', label: 'Sage' },
  { value: 'steel', label: 'Steel' },
];

const DENSITIES: Array<{ value: Density; label: string }> = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

const MOTION: Array<{ value: MotionPref; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'full', label: 'Full' },
  { value: 'reduced', label: 'Reduced' },
];

const REFRESH_OPTIONS = [
  { value: 0, label: 'Manual only' },
  { value: 15, label: 'Every 15s' },
  { value: 30, label: 'Every 30s' },
  { value: 60, label: 'Every minute' },
  { value: 300, label: 'Every 5 minutes' },
];

export function SettingsDialog() {
  const closeOverlay = useAppStore((s) => s.closeOverlay);
  const settings = useAppStore((s) => s.workspace.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const editors = useAppStore((s) => s.editors);
  const storage = useAppStore((s) => s.storage);
  const refreshStorage = useAppStore((s) => s.refreshStorage);
  const revealStorage = useAppStore((s) => s.client.revealStorage);
  const native = useAppStore((s) => s.client.native);
  const toastError = useAppStore((s) => s.toastError);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const installed = editors.filter((editor) => editor.available);

  return (
    <Dialog
      title="Settings"
      description="Stored locally with your workspace. Nothing leaves this machine."
      onClose={closeOverlay}
      wide
      footer={
        <>
          <div className="dialog__foot-spacer" />
          <Button variant="accent" onClick={closeOverlay}>
            Done
          </Button>
        </>
      }
    >
      <section className="settings-section">
        <h3 className="t-eyebrow">Appearance</h3>

        <div className="settings-row">
          <span className="settings-row__text">
            <span className="t-ui">Theme</span>
            <span className="t-meta">
              Both are dark; Graphite is warmer and slightly lifted.
            </span>
          </span>
          <Segmented
            label="Theme"
            value={settings.theme}
            options={THEMES}
            onChange={(theme) => void saveSettings({ theme })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-row__text">
            <span className="t-ui">Accent</span>
            <span className="t-meta">Used for selection, focus and running commands.</span>
          </span>
          <Segmented
            label="Accent"
            value={settings.accent}
            options={ACCENTS}
            onChange={(accent) => void saveSettings({ accent })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-row__text">
            <span className="t-ui">Density</span>
            <span className="t-meta">Compact tightens rows and padding.</span>
          </span>
          <Segmented
            label="Density"
            value={settings.density}
            options={DENSITIES}
            onChange={(density) => void saveSettings({ density })}
          />
        </div>

        <div className="settings-row">
          <span className="settings-row__text">
            <span className="t-ui">Motion</span>
            <span className="t-meta">System follows your operating system's preference.</span>
          </span>
          <Segmented
            label="Motion"
            value={settings.motion}
            options={MOTION}
            onChange={(motion) => void saveSettings({ motion })}
          />
        </div>
      </section>

      <section className="settings-section">
        <h3 className="t-eyebrow">Terminal</h3>

        <Field
          label="Output font size"
          hint={`${settings.terminalFontSize}px`}
          htmlFor="terminal-font-size"
        >
          <input
            id="terminal-font-size"
            type="range"
            min={10}
            max={20}
            step={1}
            value={settings.terminalFontSize}
            onChange={(event) =>
              void saveSettings({ terminalFontSize: Number(event.target.value) })
            }
          />
        </Field>

        <div>
          <Switch
            label="Follow new output"
            description="Scroll to the newest line until you scroll up."
            checked={settings.autoScrollOutput}
            onChange={(autoScrollOutput) => void saveSettings({ autoScrollOutput })}
          />
          <Switch
            label="Show timestamps"
            description="Prefix each line with the time it arrived."
            checked={settings.showTimestamps}
            onChange={(showTimestamps) => void saveSettings({ showTimestamps })}
          />
        </div>

        <Field label="Scrollback limit" hint="lines kept per run" htmlFor="max-output-lines">
          <select
            id="max-output-lines"
            className="input"
            value={settings.maxOutputLines}
            onChange={(event) =>
              void saveSettings({ maxOutputLines: Number(event.target.value) })
            }
          >
            {[1000, 5000, 20000, 100000].map((value) => (
              <option key={value} value={value}>
                {value.toLocaleString()} lines
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="settings-section">
        <h3 className="t-eyebrow">Editor</h3>

        <Field
          label="Default editor"
          hint={native ? `${installed.length} found on PATH` : 'desktop app only'}
          htmlFor="default-editor"
        >
          <select
            id="default-editor"
            className="input"
            value={settings.editor}
            onChange={(event) => void saveSettings({ editor: event.target.value })}
          >
            {editors.map((editor) => (
              <option key={editor.id} value={editor.id} disabled={!editor.available}>
                {editor.label}
                {editor.available ? '' : ' — not installed'}
              </option>
            ))}
            {editors.length === 0 ? (
              <option value={settings.editor}>{settings.editor}</option>
            ) : null}
            <option value="custom">Custom command…</option>
          </select>
        </Field>

        {settings.editor === 'custom' ? (
          <Field
            label="Custom command"
            hint="receives the project folder as its argument"
            htmlFor="custom-editor"
          >
            <input
              id="custom-editor"
              className="input input--mono"
              placeholder="subl"
              defaultValue={settings.customEditorCommand ?? ''}
              onBlur={(event) =>
                void saveSettings({ customEditorCommand: event.target.value.trim() || null })
              }
            />
          </Field>
        ) : null}
      </section>

      <section className="settings-section">
        <h3 className="t-eyebrow">Commands</h3>

        <div>
          <Switch
            label="One command at a time per project"
            description="Prevents a second run while one is still going."
            checked={settings.singleRunPerProject}
            onChange={(singleRunPerProject) => void saveSettings({ singleRunPerProject })}
          />
        </div>

        <Field
          label="Status refresh"
          hint="how often Git state is re-read for the open project"
          htmlFor="status-refresh"
        >
          <select
            id="status-refresh"
            className="input"
            value={settings.statusRefreshSeconds}
            onChange={(event) =>
              void saveSettings({ statusRefreshSeconds: Number(event.target.value) })
            }
          >
            {REFRESH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="settings-section">
        <h3 className="t-eyebrow">Data</h3>

        {storage ? (
          <>
            <div className="storage-grid">
              <div>
                <span className="t-eyebrow">Projects</span>
                <div className="t-ui t-num">{storage.projectCount}</div>
              </div>
              <div>
                <span className="t-eyebrow">Activity</span>
                <div className="t-ui t-num">{storage.activityCount}</div>
              </div>
              <div>
                <span className="t-eyebrow">History</span>
                <div className="t-ui t-num">{storage.historyCount}</div>
              </div>
              <div>
                <span className="t-eyebrow">On disk</span>
                <div className="t-ui t-num">{formatBytes(storage.sizeBytes)}</div>
              </div>
            </div>
            <p className="storage-path">{storage.path}</p>
            {native ? (
              <div>
                <Button
                  size="sm"
                  onClick={() =>
                    void revealStorage().catch((error) =>
                      toastError('Could not open the data folder', error),
                    )
                  }
                >
                  <FolderOpen size={13} aria-hidden />
                  Show data folder
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <Notice
            level="info"
            title="Storage details are unavailable."
            hint="They will appear once the workspace file has been written."
          />
        )}

        {!native ? (
          <Notice
            level="warn"
            title="Browser preview"
            detail="Projects, Git state and commands are simulated here."
            hint="Run `npm run app` for the real desktop application."
          />
        ) : (
          <p className="t-meta">
            <HardDrive size={12} aria-hidden style={{ verticalAlign: '-2px' }} /> Everything is
            stored in one JSON file. Deleting it resets DevWorkspace; your projects are
            untouched.
          </p>
        )}
      </section>
    </Dialog>
  );
}
