/**
 * Store tests.
 *
 * These cover the seam between the UI and the client: what the store does with
 * what the backend returns, and — just as important — what it does when the
 * backend refuses. The client is the in-memory demo implementation, wrapped
 * where a test needs to force a specific failure or drive run events directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoClient } from '@/lib/demo';
import type { WorkspaceClient } from '@/lib/ipc';
import type { OutputBatch, RunMeta } from '@/lib/types';
import {
  activeRunForProject,
  isProjectRunning,
  runsForProject,
  selectedProject,
  sortedProjects,
  useAppStore,
} from './store';

const store = () => useAppStore.getState();

/** A `localStorage` stand-in, so "survives a restart" is actually testable. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function demo(options: Parameters<typeof createDemoClient>[0] = {}) {
  return createDemoClient({ storage: null, seed: true, tickMs: 1, ...options });
}

/** Wraps a client so a test can emit run events itself. */
function controllable(base: WorkspaceClient = demo()) {
  let runState: ((meta: RunMeta) => void) | null = null;
  let output: ((batch: OutputBatch) => void) | null = null;

  const client: WorkspaceClient = {
    ...base,
    onRunState: (handler) => {
      runState = handler;
      return () => {
        runState = null;
      };
    },
    onOutput: (handler) => {
      output = handler;
      return () => {
        output = null;
      };
    },
  };

  return {
    client,
    pushRunState: (meta: RunMeta) => runState?.(meta),
    pushOutput: (batch: OutputBatch) => output?.(batch),
  };
}

function runMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: 'run_1',
    projectId: 'prj_demo_zarchat',
    projectName: 'ZARChat',
    label: 'Test',
    command: 'npm test',
    cwd: 'C:\\code\\zarchat',
    startedAt: 1_000,
    finishedAt: null,
    exitCode: null,
    status: 'running',
    ...overrides,
  };
}

async function boot(client: WorkspaceClient) {
  store().__reset(client);
  await store().bootstrap();
}

beforeEach(() => {
  store().__reset(demo());
});

// --- boot -----------------------------------------------------------------

describe('bootstrap', () => {
  it('loads the workspace and reaches the ready phase', async () => {
    await boot(demo());
    expect(store().phase).toBe('ready');
    expect(store().workspace.projects).toHaveLength(3);
    expect(store().bootError).toBeNull();
  });

  it('restores the project that was open last', async () => {
    await boot(demo());
    expect(store().selectedId).toBe('prj_demo_zarchat');
  });

  it('falls back to the first project when the remembered one is gone', async () => {
    const client: WorkspaceClient = {
      ...demo(),
      loadWorkspace: async () => {
        const workspace = await demo().loadWorkspace();
        return { ...workspace, lastProjectId: 'prj_vanished' };
      },
    };
    await boot(client);
    expect(store().selectedId).toBe(store().workspace.projects[0]?.id);
  });

  it('selects nothing when there are no projects', async () => {
    await boot(demo({ seed: false }));
    expect(store().selectedId).toBeNull();
    expect(store().phase).toBe('ready');
  });

  it('reads the status of the selected project', async () => {
    await boot(demo());
    await vi.waitFor(() => {
      expect(store().statuses['prj_demo_zarchat']).toBeDefined();
    });
    expect(store().statuses['prj_demo_zarchat']?.git.branch).toBe('feat/thread-presence');
  });

  it('reports a failure to load rather than showing an empty workspace', async () => {
    const client: WorkspaceClient = {
      ...demo(),
      loadWorkspace: async () => {
        throw { code: 'STORE_UNREADABLE', message: 'workspace.json is not valid JSON.' };
      },
    };
    await boot(client);
    expect(store().phase).toBe('failed');
    expect(store().bootError?.message).toBe('workspace.json is not valid JSON.');
    expect(store().workspace.projects).toHaveLength(0);
  });

  it('adopts a run that was already going', async () => {
    const existing = runMeta({ runId: 'run_existing' });
    const client: WorkspaceClient = { ...demo(), activeRuns: async () => [existing] };
    await boot(client);
    expect(store().runs['run_existing']).toEqual(existing);
    expect(store().focusedRunId).toBe('run_existing');
  });
});

// --- projects -------------------------------------------------------------

describe('projects', () => {
  it('adds a project, selects it and closes the dialog', async () => {
    await boot(demo({ seed: false }));
    const added = await store().addProject('C:\\code\\new-thing');

    expect(added).toBe(true);
    expect(store().workspace.projects).toHaveLength(1);
    expect(store().workspace.projects[0]?.name).toBe('new-thing');
    expect(store().selectedId).toBe(store().workspace.projects[0]?.id);
    expect(store().overlay).toBeNull();
    expect(store().toasts.at(-1)?.level).toBe('success');
  });

  it('honours an explicit display name', async () => {
    await boot(demo({ seed: false }));
    await store().addProject('C:\\code\\new-thing', 'Something Else');
    expect(store().workspace.projects[0]?.name).toBe('Something Else');
  });

  it('refuses a duplicate folder and says why', async () => {
    await boot(demo());
    const added = await store().addProject('C:\\code\\zarchat');

    expect(added).toBe(false);
    expect(store().workspace.projects).toHaveLength(3);
    const toast = store().toasts.at(-1);
    expect(toast?.level).toBe('error');
    expect(toast?.detail).toMatch(/already in DevWorkspace/);
  });

  it('removes a project and moves the selection off it', async () => {
    await boot(demo());
    await store().selectProject('prj_demo_lumen');
    await store().removeProject('prj_demo_lumen');

    expect(store().workspace.projects.map((p) => p.id)).not.toContain('prj_demo_lumen');
    expect(store().selectedId).not.toBe('prj_demo_lumen');
    expect(store().selectedId).not.toBeNull();
  });

  it('leaves the selection alone when some other project is removed', async () => {
    await boot(demo());
    await store().selectProject('prj_demo_zarchat');
    await store().removeProject('prj_demo_api');
    expect(store().selectedId).toBe('prj_demo_zarchat');
  });

  it('renames a project', async () => {
    await boot(demo());
    const saved = await store().updateProject('prj_demo_lumen', { name: 'Lumen Core' });

    expect(saved).toBe(true);
    expect(store().workspace.projects.find((p) => p.id === 'prj_demo_lumen')?.name).toBe(
      'Lumen Core',
    );
  });

  it('rejects an empty name and keeps the old one', async () => {
    await boot(demo());
    const saved = await store().updateProject('prj_demo_lumen', { name: '   ' });

    expect(saved).toBe(false);
    expect(store().workspace.projects.find((p) => p.id === 'prj_demo_lumen')?.name).toBe(
      'LUMEN',
    );
    expect(store().toasts.at(-1)?.level).toBe('error');
  });

  it('rejects a repository URL that cannot be opened', async () => {
    await boot(demo());
    const saved = await store().updateProject('prj_demo_lumen', {
      repositoryUrl: 'javascript:alert(1)',
    });

    expect(saved).toBe(false);
    expect(store().toasts.at(-1)?.hint).toMatch(/full web address/);
  });

  it('toggles favourite both ways', async () => {
    await boot(demo());
    const favorite = () =>
      store().workspace.projects.find((p) => p.id === 'prj_demo_lumen')?.favorite;

    expect(favorite()).toBe(false);
    await store().toggleFavorite('prj_demo_lumen');
    expect(favorite()).toBe(true);
    await store().toggleFavorite('prj_demo_lumen');
    expect(favorite()).toBe(false);
  });

  it('survives a restart', async () => {
    const storage = memoryStorage();
    await boot(demo({ storage, seed: false }));
    await store().addProject('C:\\code\\persisted', 'Persisted');

    // A second client over the same storage stands in for a relaunch.
    await boot(demo({ storage, seed: false }));
    expect(store().workspace.projects.map((p) => p.name)).toEqual(['Persisted']);
    expect(store().selectedId).toBe(store().workspace.projects[0]?.id);
  });
});

// --- commands -------------------------------------------------------------

describe('commands', () => {
  it('adds a command to a project', async () => {
    await boot(demo());
    const added = await store().addCommand('prj_demo_lumen', 'Check', 'cargo clippy', 'lint');

    expect(added).toBe(true);
    const commands = store().workspace.projects.find(
      (p) => p.id === 'prj_demo_lumen',
    )?.commands;
    expect(commands?.map((c) => c.program)).toContain('cargo clippy');
    expect(commands?.at(-1)?.source).toBe('manual');
  });

  it('refuses an empty command', async () => {
    await boot(demo());
    const added = await store().addCommand('prj_demo_lumen', 'Nothing', '   ', 'custom');

    expect(added).toBe(false);
    expect(store().toasts.at(-1)?.level).toBe('error');
  });

  it('edits a command in place', async () => {
    await boot(demo());
    const project = store().workspace.projects.find((p) => p.id === 'prj_demo_lumen');
    const target = project!.commands[0]!;

    await store().updateCommand(
      'prj_demo_lumen',
      target.id,
      'Run',
      'cargo run --release',
      'dev',
    );
    const updated = store()
      .workspace.projects.find((p) => p.id === 'prj_demo_lumen')
      ?.commands.find((c) => c.id === target.id);
    expect(updated?.program).toBe('cargo run --release');
  });

  it('removes a command', async () => {
    await boot(demo());
    const target = store().workspace.projects.find((p) => p.id === 'prj_demo_lumen')!
      .commands[0]!;

    await store().removeCommand('prj_demo_lumen', target.id);
    const commands = store().workspace.projects.find(
      (p) => p.id === 'prj_demo_lumen',
    )?.commands;
    expect(commands?.map((c) => c.id)).not.toContain(target.id);
  });
});

// --- running --------------------------------------------------------------

describe('running commands', () => {
  it('registers the run, focuses it, and streams output until it succeeds', async () => {
    await boot(demo());
    await store().runCommand('prj_demo_zarchat', 'Test', 'npm test');

    const runId = store().focusedRunId!;
    expect(runId).toBeTruthy();
    expect(store().runs[runId]?.status).toBe('running');
    expect(store().output[runId]?.[0]?.text).toBe('$ npm test');

    await vi.waitFor(() => {
      expect(store().runs[runId]?.status).toBe('succeeded');
    });
    expect(store().runs[runId]?.exitCode).toBe(0);
    expect(store().output[runId]!.length).toBeGreaterThan(5);
  });

  it('records the run in history once it finishes', async () => {
    await boot(demo());
    await store().runCommand('prj_demo_zarchat', 'Test', 'npm test');

    await vi.waitFor(() => {
      expect(store().workspace.history).toHaveLength(1);
    });
    const entry = store().workspace.history[0];
    expect(entry?.command).toBe('npm test');
    expect(entry?.status).toBe('succeeded');
  });

  it('refuses a second run in the same project while one is going', async () => {
    await boot(demo());
    await store().runCommand('prj_demo_zarchat', 'Dev', 'npm run dev');
    await store().runCommand('prj_demo_zarchat', 'Test', 'npm test');

    const toast = store().toasts.at(-1);
    expect(toast?.level).toBe('error');
    expect(toast?.detail).toMatch(/already running/i);
  });

  it('cancels a run', async () => {
    await boot(demo());
    await store().runCommand('prj_demo_zarchat', 'Dev', 'npm run dev');
    const runId = store().focusedRunId!;

    await store().cancelRun(runId);
    await vi.waitFor(() => {
      expect(store().runs[runId]?.status).toBe('cancelled');
    });
    expect(store().output[runId]?.at(-1)?.text).toMatch(/cancelled/);
  });

  it('stays quiet when cancelling something that already finished', async () => {
    await boot(demo());
    await store().runCommand('prj_demo_zarchat', 'Test', 'npm test');
    const runId = store().focusedRunId!;
    await vi.waitFor(() => {
      expect(store().runs[runId]?.status).toBe('succeeded');
    });

    const before = store().toasts.length;
    await store().cancelRun(runId);
    expect(store().toasts).toHaveLength(before);
  });

  it('reports a cancellation that genuinely failed', async () => {
    const client: WorkspaceClient = {
      ...demo(),
      cancelRun: async () => {
        throw { code: 'SIGNAL_FAILED', message: 'The process ignored the signal.' };
      },
    };
    await boot(client);
    await store().cancelRun('run_whatever');

    expect(store().toasts.at(-1)?.detail).toBe('The process ignored the signal.');
  });

  it('reports a command that could not start', async () => {
    const client: WorkspaceClient = {
      ...demo(),
      runCommand: async () => {
        throw {
          code: 'SPAWN_FAILED',
          message: 'npm is not on your PATH.',
          hint: 'Install Node.',
        };
      },
    };
    await boot(client);
    await store().runCommand('prj_demo_zarchat', 'Test', 'npm test');

    const toast = store().toasts.at(-1);
    expect(toast?.title).toBe('Could not run Test');
    expect(toast?.detail).toBe('npm is not on your PATH.');
    expect(toast?.hint).toBe('Install Node.');
  });

  it('raises a toast when a run exits non-zero', async () => {
    const harness = controllable();
    await boot(harness.client);

    harness.pushRunState(runMeta({ status: 'failed', exitCode: 1, finishedAt: 2_000 }));

    const toast = store().toasts.at(-1);
    expect(toast?.level).toBe('error');
    expect(toast?.title).toBe('Test failed in ZARChat');
    expect(toast?.detail).toBe('npm test · exit 1');
  });

  it('does not raise a toast when a run succeeds', async () => {
    const harness = controllable();
    await boot(harness.client);
    const before = store().toasts.length;

    harness.pushRunState(runMeta({ status: 'succeeded', exitCode: 0, finishedAt: 2_000 }));
    expect(store().toasts).toHaveLength(before);
  });

  it('trims output to the configured scrollback limit', async () => {
    const harness = controllable();
    await boot(harness.client);
    useAppStore.setState((state) => ({
      workspace: {
        ...state.workspace,
        settings: { ...state.workspace.settings, maxOutputLines: 3 },
      },
    }));

    harness.pushOutput({
      runId: 'run_1',
      lines: Array.from({ length: 10 }, (_, index) => ({
        seq: index,
        stream: 'stdout' as const,
        text: `line ${index}`,
        at: 0,
      })),
    });

    const lines = store().output['run_1']!;
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.text)).toEqual(['line 7', 'line 8', 'line 9']);
  });

  it('clears the output of one run without touching another', async () => {
    const harness = controllable();
    await boot(harness.client);

    harness.pushOutput({
      runId: 'run_a',
      lines: [{ seq: 0, stream: 'stdout', text: 'a', at: 0 }],
    });
    harness.pushOutput({
      runId: 'run_b',
      lines: [{ seq: 0, stream: 'stdout', text: 'b', at: 0 }],
    });

    store().clearOutput('run_a');
    expect(store().output['run_a']).toEqual([]);
    expect(store().output['run_b']).toHaveLength(1);
  });
});

// --- settings -------------------------------------------------------------

describe('settings', () => {
  it('applies a change and keeps it', async () => {
    await boot(demo());
    await store().saveSettings({ theme: 'graphite', accent: 'sage' });

    expect(store().workspace.settings.theme).toBe('graphite');
    expect(store().workspace.settings.accent).toBe('sage');
  });

  it('adopts the value the backend actually stored', async () => {
    await boot(demo());
    // The demo client clamps font size to 10–20, as the Rust store does.
    await store().saveSettings({ terminalFontSize: 99 });
    expect(store().workspace.settings.terminalFontSize).toBe(20);
  });

  it('rolls back and explains when a setting cannot be saved', async () => {
    const client: WorkspaceClient = {
      ...demo(),
      saveSettings: async () => {
        throw { code: 'STORE_WRITE_FAILED', message: 'The workspace file is read-only.' };
      },
    };
    await boot(client);
    const before = store().workspace.settings.theme;

    await store().saveSettings({ theme: 'graphite' });
    expect(store().workspace.settings.theme).toBe(before);
    expect(store().toasts.at(-1)?.detail).toBe('The workspace file is read-only.');
  });

  it('survives a restart', async () => {
    const storage = memoryStorage();
    await boot(demo({ storage }));
    await store().saveSettings({ density: 'compact', showTimestamps: true });

    await boot(demo({ storage }));
    expect(store().workspace.settings.density).toBe('compact');
    expect(store().workspace.settings.showTimestamps).toBe(true);
  });
});

// --- activity and quick actions ------------------------------------------

describe('activity', () => {
  it('clears the log', async () => {
    await boot(demo({ seed: false }));
    await store().addProject('C:\\code\\thing');
    await vi.waitFor(() => {
      expect(store().workspace.activity.length).toBeGreaterThan(0);
    });

    await store().clearActivity();
    expect(store().workspace.activity).toHaveLength(0);
  });

  it('explains a quick action that is not available here', async () => {
    await boot(demo());
    await store().quickAction('editor', 'prj_demo_zarchat');

    const toast = store().toasts.at(-1);
    expect(toast?.level).toBe('error');
    expect(toast?.title).toBe('Open in editor failed');
    expect(toast?.hint).toMatch(/npm run app/);
  });

  it('records a quick action that worked', async () => {
    const client: WorkspaceClient = { ...demo(), openFolder: async () => {} };
    await boot(client);
    await store().quickAction('folder', 'prj_demo_zarchat');

    await vi.waitFor(() => {
      expect(store().workspace.activity.some((entry) => entry.title === 'Open folder')).toBe(
        true,
      );
    });
    expect(store().toasts).toHaveLength(0);
  });
});

// --- toasts ---------------------------------------------------------------

describe('toasts', () => {
  it('keeps only the four most recent', () => {
    for (let i = 0; i < 6; i += 1) store().toast({ level: 'info', title: `t${i}` });

    expect(store().toasts).toHaveLength(4);
    expect(store().toasts.map((t) => t.title)).toEqual(['t2', 't3', 't4', 't5']);
  });

  it('dismisses one by id', () => {
    store().toast({ level: 'info', title: 'first' });
    store().toast({ level: 'info', title: 'second' });
    const [first] = store().toasts;

    store().dismissToast(first!.id);
    expect(store().toasts.map((t) => t.title)).toEqual(['second']);
  });

  it('turns an unrecognised throw into something readable', () => {
    store().toastError('Something broke', 'just a string');
    const toast = store().toasts.at(-1);
    expect(toast?.level).toBe('error');
    expect(toast?.detail).toBeTruthy();
    expect(toast?.detail).not.toBe('[object Object]');
  });
});

// --- overlays -------------------------------------------------------------

describe('overlays', () => {
  it('opens and closes', () => {
    store().openOverlay('palette');
    expect(store().overlay).toBe('palette');
    store().closeOverlay();
    expect(store().overlay).toBeNull();
  });

  it('opening project settings records which project', () => {
    store().editProject('prj_demo_lumen');
    expect(store().overlay).toBe('projectSettings');
    expect(store().editingProjectId).toBe('prj_demo_lumen');
  });

  it('closing forgets the project being edited', () => {
    store().editProject('prj_demo_lumen');
    store().closeOverlay();
    expect(store().overlay).toBeNull();
    expect(store().editingProjectId).toBeNull();
  });

  it('falls back to the add-project dialog when there is no native picker', async () => {
    await boot(demo());
    await store().pickAndAddProject();
    expect(store().overlay).toBe('addProject');
  });
});

// --- selectors ------------------------------------------------------------

describe('selectors', () => {
  it('puts favourites first, then most recently opened', async () => {
    await boot(demo());
    const order = sortedProjects(store()).map((p) => p.name);
    expect(order[0]).toBe('ZARChat');
    expect(order).toEqual(['ZARChat', 'LUMEN', 'Atlas API']);
  });

  it('resolves the selected project, or null', async () => {
    await boot(demo());
    expect(selectedProject(store())?.id).toBe('prj_demo_zarchat');

    await store().selectProject(null);
    expect(selectedProject(store())).toBeNull();
  });

  it('returns null when the selected project no longer exists', async () => {
    await boot(demo());
    useAppStore.setState({ selectedId: 'prj_gone' });
    expect(selectedProject(store())).toBeNull();
  });

  it('groups runs by project in start order', () => {
    useAppStore.setState({
      runs: {
        b: runMeta({ runId: 'b', startedAt: 2_000 }),
        a: runMeta({ runId: 'a', startedAt: 1_000 }),
        other: runMeta({ runId: 'other', projectId: 'prj_demo_lumen' }),
      },
    });

    expect(runsForProject(store(), 'prj_demo_zarchat').map((r) => r.runId)).toEqual(['a', 'b']);
  });

  it('knows whether a project is busy', () => {
    useAppStore.setState({
      runs: {
        done: runMeta({ runId: 'done', status: 'succeeded' }),
        going: runMeta({ runId: 'going', status: 'running', startedAt: 5_000 }),
      },
    });

    expect(isProjectRunning(store(), 'prj_demo_zarchat')).toBe(true);
    expect(activeRunForProject(store(), 'prj_demo_zarchat')?.runId).toBe('going');
    expect(isProjectRunning(store(), 'prj_demo_lumen')).toBe(false);
  });
});
