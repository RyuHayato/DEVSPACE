/**
 * Application state.
 *
 * One store holds the mirrored workspace, live run output, and transient UI
 * state. Mutations always go through the client first and then adopt whatever
 * the backend returns, so the UI can never show a change that was not
 * actually persisted.
 */

import { create } from 'zustand';
import { createDemoClient } from '@/lib/demo';
import {
  createTauriClient,
  isTauri,
  toAppError,
  type Unsubscribe,
  type WorkspaceClient,
} from '@/lib/ipc';
import {
  EMPTY_WORKSPACE,
  type ActivityInput,
  type AppError,
  type CommandKind,
  type EditorInfo,
  type OutputLine,
  type ProjectPatch,
  type ProjectStatus,
  type Project,
  type RunMeta,
  type Settings,
  type StorageInfo,
  type Workspace,
} from '@/lib/types';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: string;
  level: ToastLevel;
  title: string;
  detail?: string;
  hint?: string;
}

export type Overlay = 'palette' | 'settings' | 'addProject' | 'projectSettings' | null;

export type QuickAction = 'editor' | 'folder' | 'terminal' | 'repository';

/** A status refresh inside this window is treated as current. */
const STATUS_FRESH_MS = 1_500;
const TOAST_LIMIT = 4;

export interface AppState {
  client: WorkspaceClient;
  phase: 'loading' | 'ready' | 'failed';
  bootError: AppError | null;

  workspace: Workspace;
  selectedId: string | null;

  statuses: Record<string, ProjectStatus | undefined>;
  statusPending: Record<string, boolean | undefined>;
  statusErrors: Record<string, AppError | undefined>;

  runs: Record<string, RunMeta | undefined>;
  output: Record<string, OutputLine[] | undefined>;
  focusedRunId: string | null;

  editors: EditorInfo[];
  storage: StorageInfo | null;

  toasts: Toast[];
  overlay: Overlay;
  /** Project whose settings dialog is open. */
  editingProjectId: string | null;
  /** Keyed in-flight flags, so individual buttons can show progress. */
  busy: Record<string, boolean | undefined>;

  bootstrap(): Promise<void>;
  teardown(): void;

  selectProject(id: string | null): Promise<void>;
  refreshStatus(projectId: string, options?: { force?: boolean }): Promise<void>;
  refreshAllStatuses(): Promise<void>;

  runCommand(projectId: string, label: string, program: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  clearOutput(runId: string): void;
  focusRun(runId: string | null): void;

  addProject(path: string, name?: string): Promise<boolean>;
  pickAndAddProject(): Promise<void>;
  removeProject(id: string): Promise<void>;
  updateProject(id: string, patch: ProjectPatch): Promise<boolean>;
  toggleFavorite(id: string): Promise<void>;

  addCommand(
    projectId: string,
    label: string,
    program: string,
    kind: CommandKind,
  ): Promise<boolean>;
  updateCommand(
    projectId: string,
    commandId: string,
    label: string,
    program: string,
    kind: CommandKind,
  ): Promise<boolean>;
  removeCommand(projectId: string, commandId: string): Promise<void>;
  syncDetectedCommands(projectId: string): Promise<void>;

  saveSettings(patch: Partial<Settings>): Promise<void>;
  clearActivity(): Promise<void>;
  refreshStorage(): Promise<void>;

  quickAction(action: QuickAction, projectId: string): Promise<void>;
  logActivity(entry: ActivityInput): void;

  openOverlay(overlay: Overlay): void;
  closeOverlay(): void;
  editProject(id: string | null): void;

  toast(toast: Omit<Toast, 'id'>): void;
  toastError(title: string, error: unknown): void;
  dismissToast(id: string): void;

  /** Replaces the client and resets everything. For tests only. */
  __reset(client?: WorkspaceClient): void;
}

function defaultClient(): WorkspaceClient {
  return isTauri() ? createTauriClient() : createDemoClient();
}

let toastCounter = 0;
let subscriptions: Unsubscribe[] = [];

const ACTION_LABELS: Record<QuickAction, string> = {
  editor: 'Open in editor',
  folder: 'Open folder',
  terminal: 'Open terminal',
  repository: 'Open repository',
};

export const useAppStore = create<AppState>((set, get) => ({
  client: defaultClient(),
  phase: 'loading',
  bootError: null,

  workspace: EMPTY_WORKSPACE,
  selectedId: null,

  statuses: {},
  statusPending: {},
  statusErrors: {},

  runs: {},
  output: {},
  focusedRunId: null,

  editors: [],
  storage: null,

  toasts: [],
  overlay: null,
  editingProjectId: null,
  busy: {},

  // --- lifecycle ---------------------------------------------------------

  async bootstrap() {
    const { client } = get();
    set({ phase: 'loading', bootError: null });

    try {
      const workspace = await client.loadWorkspace();
      const selectedId =
        workspace.lastProjectId &&
        workspace.projects.some((p) => p.id === workspace.lastProjectId)
          ? workspace.lastProjectId
          : (workspace.projects[0]?.id ?? null);

      set({ workspace, selectedId, phase: 'ready' });

      // Adopt any run still going from before a reload.
      const active = await client.activeRuns();
      if (active.length > 0) {
        set((state) => ({
          runs: { ...state.runs, ...Object.fromEntries(active.map((r) => [r.runId, r])) },
          focusedRunId: state.focusedRunId ?? active[active.length - 1]?.runId ?? null,
        }));
      }

      subscriptions.forEach((off) => off());
      subscriptions = [
        client.onOutput(({ runId, lines }) => {
          const limit = get().workspace.settings.maxOutputLines;
          set((state) => {
            const existing = state.output[runId] ?? [];
            const merged = existing.concat(lines);
            return {
              output: {
                ...state.output,
                [runId]: merged.length > limit ? merged.slice(merged.length - limit) : merged,
              },
            };
          });
        }),
        client.onRunState((meta) => {
          set((state) => ({
            runs: { ...state.runs, [meta.runId]: meta },
            focusedRunId: state.focusedRunId ?? meta.runId,
          }));
          if (meta.status === 'failed' || meta.status === 'error') {
            get().toast({
              level: 'error',
              title: `${meta.label} failed in ${meta.projectName}`,
              detail:
                meta.exitCode === null
                  ? meta.command
                  : `${meta.command} · exit ${meta.exitCode}`,
              hint: 'The output panel has the full log.',
            });
          }
          if (meta.status !== 'running')
            void get().refreshStatus(meta.projectId, { force: true });
        }),
        client.onWorkspaceChanged((workspace) => set({ workspace })),
      ];

      if (client.native) {
        client
          .availableEditors()
          .then((editors) => set({ editors }))
          .catch(() => set({ editors: [] }));
      }
      if (selectedId) void get().refreshStatus(selectedId, { force: true });
      // The sidebar shows each project's Git state, so warm the rest once at
      // startup rather than re-reading them on a timer.
      void get().refreshAllStatuses();
    } catch (thrown) {
      set({ phase: 'failed', bootError: toAppError(thrown) });
    }
  },

  teardown() {
    subscriptions.forEach((off) => off());
    subscriptions = [];
  },

  // --- projects ---------------------------------------------------------

  async selectProject(id) {
    if (get().selectedId === id) return;
    set({ selectedId: id });
    if (!id) return;

    void get().refreshStatus(id);
    try {
      await get().client.setLastProject(id);
      const workspace = await get().client.loadWorkspace();
      set({ workspace });
    } catch {
      // Remembering the selection is a convenience; failing to record it must
      // not interrupt navigation.
    }
  },

  async refreshStatus(projectId, options) {
    const state = get();
    const existing = state.statuses[projectId];
    if (!options?.force && existing && Date.now() - existing.checkedAt < STATUS_FRESH_MS) {
      return;
    }
    if (state.statusPending[projectId]) return;

    set((s) => ({ statusPending: { ...s.statusPending, [projectId]: true } }));
    try {
      const status = await state.client.projectStatus(projectId);
      set((s) => ({
        statuses: { ...s.statuses, [projectId]: status },
        statusErrors: { ...s.statusErrors, [projectId]: undefined },
      }));
    } catch (thrown) {
      set((s) => ({ statusErrors: { ...s.statusErrors, [projectId]: toAppError(thrown) } }));
    } finally {
      set((s) => ({ statusPending: { ...s.statusPending, [projectId]: false } }));
    }
  },

  async refreshAllStatuses() {
    // Sequential on purpose: reading a dozen working trees at once would
    // spike disk I/O for no perceptible gain.
    for (const project of get().workspace.projects) {
      await get().refreshStatus(project.id);
    }
  },

  async addProject(path, name) {
    try {
      const { project } = await get().client.addProject(path, name);
      const workspace = await get().client.loadWorkspace();
      set({ workspace, selectedId: project.id, overlay: null });
      void get().refreshStatus(project.id, { force: true });
      get().toast({
        level: 'success',
        title: `${project.name} added`,
        detail: project.path,
      });
      return true;
    } catch (thrown) {
      get().toastError('Could not add that project', thrown);
      return false;
    }
  },

  async pickAndAddProject() {
    const { client } = get();
    if (!client.native) {
      set({ overlay: 'addProject' });
      return;
    }
    try {
      const picked = await client.pickDirectory();
      if (picked) await get().addProject(picked);
    } catch (thrown) {
      get().toastError('Could not open the folder picker', thrown);
    }
  },

  async removeProject(id) {
    const project = get().workspace.projects.find((p) => p.id === id);
    try {
      const workspace = await get().client.removeProject(id);
      const selectedId =
        get().selectedId === id
          ? (workspace.lastProjectId ?? workspace.projects[0]?.id ?? null)
          : get().selectedId;
      set({ workspace, selectedId, overlay: null, editingProjectId: null });
      get().toast({
        level: 'info',
        title: `${project?.name ?? 'Project'} removed`,
        detail: 'The folder on disk was not changed.',
      });
    } catch (thrown) {
      get().toastError('Could not remove that project', thrown);
    }
  },

  async updateProject(id, patch) {
    try {
      const project = await get().client.updateProject(id, patch);
      set((state) => ({
        workspace: {
          ...state.workspace,
          projects: state.workspace.projects.map((p) => (p.id === id ? project : p)),
        },
      }));
      if (patch.path) void get().refreshStatus(id, { force: true });
      return true;
    } catch (thrown) {
      get().toastError('Could not save those changes', thrown);
      return false;
    }
  },

  async toggleFavorite(id) {
    const project = get().workspace.projects.find((p) => p.id === id);
    if (!project) return;
    await get().updateProject(id, { favorite: !project.favorite });
  },

  // --- commands ---------------------------------------------------------

  async addCommand(projectId, label, program, kind) {
    try {
      const project = await get().client.addCommand(projectId, label, program, kind);
      replaceProject(set, project);
      return true;
    } catch (thrown) {
      get().toastError('Could not add that command', thrown);
      return false;
    }
  },

  async updateCommand(projectId, commandId, label, program, kind) {
    try {
      const project = await get().client.updateCommand(
        projectId,
        commandId,
        label,
        program,
        kind,
      );
      replaceProject(set, project);
      return true;
    } catch (thrown) {
      get().toastError('Could not save that command', thrown);
      return false;
    }
  },

  async removeCommand(projectId, commandId) {
    try {
      const project = await get().client.removeCommand(projectId, commandId);
      replaceProject(set, project);
    } catch (thrown) {
      get().toastError('Could not remove that command', thrown);
    }
  },

  async syncDetectedCommands(projectId) {
    try {
      const before =
        get().workspace.projects.find((p) => p.id === projectId)?.commands.length ?? 0;
      const project = await get().client.syncDetectedCommands(projectId);
      replaceProject(set, project);
      const added = project.commands.length - before;
      get().toast({
        level: added > 0 ? 'success' : 'info',
        title:
          added > 0
            ? `${added} command${added === 1 ? '' : 's'} detected`
            : 'No new commands found',
        detail: added > 0 ? undefined : 'Everything detectable is already configured.',
      });
    } catch (thrown) {
      get().toastError('Could not re-scan this project', thrown);
    }
  },

  // --- running ----------------------------------------------------------

  async runCommand(projectId, label, program) {
    const key = `run:${projectId}`;
    if (get().busy[key]) return;
    set((state) => ({ busy: { ...state.busy, [key]: true } }));
    try {
      const meta = await get().client.runCommand(projectId, label, program);
      set((state) => ({
        runs: { ...state.runs, [meta.runId]: meta },
        output: { ...state.output, [meta.runId]: state.output[meta.runId] ?? [] },
        focusedRunId: meta.runId,
      }));
    } catch (thrown) {
      get().toastError(`Could not run ${label}`, thrown);
    } finally {
      set((state) => ({ busy: { ...state.busy, [key]: false } }));
    }
  },

  async cancelRun(runId) {
    try {
      await get().client.cancelRun(runId);
    } catch (thrown) {
      const error = toAppError(thrown);
      // A run that finished a moment ago is not worth alarming anyone over.
      if (error.code !== 'RUN_NOT_FOUND')
        get().toastError('Could not stop that command', thrown);
    }
  },

  clearOutput(runId) {
    set((state) => ({ output: { ...state.output, [runId]: [] } }));
  },

  focusRun(runId) {
    set({ focusedRunId: runId });
  },

  // --- settings & storage -----------------------------------------------

  async saveSettings(patch) {
    const previous = get().workspace.settings;
    const next = { ...previous, ...patch };
    // Applied optimistically so appearance changes feel immediate.
    set((state) => ({ workspace: { ...state.workspace, settings: next } }));
    try {
      const saved = await get().client.saveSettings(next);
      set((state) => ({ workspace: { ...state.workspace, settings: saved } }));
    } catch (thrown) {
      set((state) => ({ workspace: { ...state.workspace, settings: previous } }));
      get().toastError('Could not save that setting', thrown);
    }
  },

  async clearActivity() {
    try {
      const workspace = await get().client.clearActivity();
      set({ workspace });
      void get().refreshStorage();
    } catch (thrown) {
      get().toastError('Could not clear the activity log', thrown);
    }
  },

  async refreshStorage() {
    try {
      set({ storage: await get().client.storageInfo() });
    } catch {
      set({ storage: null });
    }
  },

  // --- quick actions ----------------------------------------------------

  async quickAction(action, projectId) {
    const key = `action:${action}:${projectId}`;
    if (get().busy[key]) return;
    set((state) => ({ busy: { ...state.busy, [key]: true } }));

    const { client } = get();
    const run = {
      editor: () => client.openInEditor(projectId),
      folder: () => client.openFolder(projectId),
      terminal: () => client.openTerminal(projectId),
      repository: () => client.openRepository(projectId),
    }[action];

    try {
      await run();
      get().logActivity({
        kind: 'actionRun',
        projectId,
        title: ACTION_LABELS[action],
      });
    } catch (thrown) {
      get().toastError(ACTION_LABELS[action] + ' failed', thrown);
    } finally {
      set((state) => ({ busy: { ...state.busy, [key]: false } }));
    }
  },

  logActivity(entry) {
    void get()
      .client.logActivity(entry)
      .then(() => get().client.loadWorkspace())
      .then((workspace) => set({ workspace }))
      .catch(() => {
        // The activity log is a convenience; a failure here is not worth
        // interrupting the action the user actually asked for.
      });
  },

  // --- UI ---------------------------------------------------------------

  openOverlay(overlay) {
    set({ overlay });
    if (overlay === 'settings') void get().refreshStorage();
  },

  closeOverlay() {
    set({ overlay: null, editingProjectId: null });
  },

  editProject(id) {
    set({ editingProjectId: id, overlay: id ? 'projectSettings' : null });
  },

  toast(toast) {
    const id = `toast_${(toastCounter += 1)}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }].slice(-TOAST_LIMIT) }));
  },

  toastError(title, error) {
    const normalized = toAppError(error);
    get().toast({
      level: 'error',
      title,
      detail: normalized.message,
      hint: normalized.hint,
    });
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  __reset(client) {
    subscriptions.forEach((off) => off());
    subscriptions = [];
    set({
      client: client ?? defaultClient(),
      phase: 'loading',
      bootError: null,
      workspace: EMPTY_WORKSPACE,
      selectedId: null,
      statuses: {},
      statusPending: {},
      statusErrors: {},
      runs: {},
      output: {},
      focusedRunId: null,
      editors: [],
      storage: null,
      toasts: [],
      overlay: null,
      editingProjectId: null,
      busy: {},
    });
  },
}));

function replaceProject(
  set: (updater: (state: AppState) => Partial<AppState>) => void,
  project: Project,
) {
  set((state) => ({
    workspace: {
      ...state.workspace,
      projects: state.workspace.projects.map((p) => (p.id === project.id ? project : p)),
    },
  }));
}

// --- selectors -----------------------------------------------------------

export function selectedProject(state: AppState): Project | null {
  if (!state.selectedId) return null;
  return state.workspace.projects.find((p) => p.id === state.selectedId) ?? null;
}

/** Favourites first, then most recently opened, then alphabetical. */
export function sortedProjects(state: AppState): Project[] {
  return [...state.workspace.projects].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    const opened = (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
    if (opened !== 0) return opened;
    return a.name.localeCompare(b.name);
  });
}

export function runsForProject(state: AppState, projectId: string): RunMeta[] {
  return Object.values(state.runs)
    .filter((run): run is RunMeta => !!run && run.projectId === projectId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function activeRunForProject(state: AppState, projectId: string): RunMeta | null {
  return runsForProject(state, projectId).find((run) => run.status === 'running') ?? null;
}

export function isProjectRunning(state: AppState, projectId: string): boolean {
  return activeRunForProject(state, projectId) !== null;
}
