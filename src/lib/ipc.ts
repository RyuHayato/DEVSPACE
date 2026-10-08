/**
 * The boundary between the UI and the system.
 *
 * Everything the UI can do goes through `WorkspaceClient`. There are two
 * implementations: one backed by Tauri commands, and an in-memory one used by
 * the test suite and by `npm run dev` in a plain browser. Because the UI only
 * ever sees this interface, nothing in it needs to know which is in play.
 */

import type {
  ActivityInput,
  AddProjectResult,
  AppError,
  CommandKind,
  EditorInfo,
  OutputBatch,
  Project,
  ProjectPatch,
  ProjectStatus,
  RunMeta,
  Settings,
  StorageInfo,
  Workspace,
} from './types';

export type Unsubscribe = () => void;

export interface WorkspaceClient {
  /** True when real filesystem, Git and process access is available. */
  readonly native: boolean;

  loadWorkspace(): Promise<Workspace>;
  addProject(path: string, name?: string): Promise<AddProjectResult>;
  removeProject(id: string): Promise<Workspace>;
  updateProject(id: string, patch: ProjectPatch): Promise<Project>;
  setLastProject(id: string | null): Promise<void>;

  addCommand(
    projectId: string,
    label: string,
    program: string,
    kind: CommandKind,
  ): Promise<Project>;
  updateCommand(
    projectId: string,
    commandId: string,
    label: string,
    program: string,
    kind: CommandKind,
  ): Promise<Project>;
  removeCommand(projectId: string, commandId: string): Promise<Project>;
  syncDetectedCommands(projectId: string): Promise<Project>;

  projectStatus(projectId: string): Promise<ProjectStatus>;

  runCommand(projectId: string, label: string, program: string): Promise<RunMeta>;
  cancelRun(runId: string): Promise<RunMeta>;
  activeRuns(): Promise<RunMeta[]>;

  saveSettings(settings: Settings): Promise<Settings>;
  logActivity(entry: ActivityInput): Promise<void>;
  clearActivity(): Promise<Workspace>;

  storageInfo(): Promise<StorageInfo>;
  revealStorage(): Promise<void>;
  availableEditors(): Promise<EditorInfo[]>;

  openInEditor(projectId: string): Promise<void>;
  openFolder(projectId: string): Promise<void>;
  openTerminal(projectId: string): Promise<void>;
  openRepository(projectId: string): Promise<void>;

  /** Opens the system folder picker. Resolves to null if cancelled. */
  pickDirectory(): Promise<string | null>;

  onOutput(handler: (batch: OutputBatch) => void): Unsubscribe;
  onRunState(handler: (meta: RunMeta) => void): Unsubscribe;
  onWorkspaceChanged(handler: (workspace: Workspace) => void): Unsubscribe;
}

/** True when running inside the Tauri shell rather than a plain browser. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Normalises anything thrown across the IPC boundary into an `AppError`.
 *
 * The Rust side always rejects with a structured error, but a transport
 * failure or a programming mistake can still surface as a string or an
 * `Error`, and the UI must never render `[object Object]`.
 */
export function toAppError(thrown: unknown): AppError {
  if (thrown && typeof thrown === 'object') {
    const candidate = thrown as Partial<AppError>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return {
        code: candidate.code,
        message: candidate.message,
        ...(candidate.hint ? { hint: candidate.hint } : {}),
      };
    }
    if (thrown instanceof Error) {
      return { code: 'UNEXPECTED', message: thrown.message || 'Something went wrong.' };
    }
  }
  if (typeof thrown === 'string' && thrown.trim()) {
    return { code: 'UNEXPECTED', message: thrown };
  }
  return {
    code: 'UNEXPECTED',
    message: 'Something went wrong.',
    hint: 'Try again. If it keeps happening, restart DevWorkspace.',
  };
}

/** Re-throws as an `AppError` so every caller can assume one shape. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (thrown) {
    throw toAppError(thrown);
  }
}

const EVENT_OUTPUT = 'run://output';
const EVENT_RUN_STATE = 'run://state';
const EVENT_WORKSPACE = 'workspace://changed';

export function createTauriClient(): WorkspaceClient {
  // Imported lazily so this module stays loadable in a plain browser.
  const api = () => import('@tauri-apps/api/core');
  const events = () => import('@tauri-apps/api/event');

  const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
    guard(async () => {
      const { invoke } = await api();
      return invoke<T>(command, args);
    });

  /**
   * Bridges Tauri's async `listen` onto a synchronous unsubscribe, and copes
   * with the component unmounting before the listener is registered.
   */
  const subscribe = <T>(name: string, handler: (payload: T) => void): Unsubscribe => {
    let disposed = false;
    let detach: (() => void) | null = null;
    void events().then(async ({ listen }) => {
      const stop = await listen<T>(name, (event) => handler(event.payload));
      if (disposed) stop();
      else detach = stop;
    });
    return () => {
      disposed = true;
      detach?.();
    };
  };

  return {
    native: true,

    loadWorkspace: () => call('load_workspace'),
    addProject: (path, name) => call('add_project', { path, name: name ?? null }),
    removeProject: (id) => call('remove_project', { id }),
    updateProject: (id, patch) => call('update_project', { id, patch }),
    setLastProject: (id) => call('set_last_project', { id }),

    addCommand: (projectId, label, program, kind) =>
      call('add_command', { projectId, label, program, kind }),
    updateCommand: (projectId, commandId, label, program, kind) =>
      call('update_command', { projectId, commandId, label, program, kind }),
    removeCommand: (projectId, commandId) => call('remove_command', { projectId, commandId }),
    syncDetectedCommands: (projectId) => call('sync_detected_commands', { projectId }),

    projectStatus: (projectId) => call('project_status', { projectId }),

    runCommand: (projectId, label, program) =>
      call('run_command', { projectId, label, program }),
    cancelRun: (runId) => call('cancel_run', { runId }),
    activeRuns: () => call('active_runs'),

    saveSettings: (settings) => call('save_settings', { settings }),
    logActivity: (entry) => call('log_activity', { entry }),
    clearActivity: () => call('clear_activity'),

    storageInfo: () => call('storage_info'),
    revealStorage: () => call('reveal_storage'),
    availableEditors: () => call('available_editors'),

    openInEditor: (projectId) => call('open_in_editor', { projectId }),
    openFolder: (projectId) => call('open_project_folder', { projectId }),
    openTerminal: (projectId) => call('open_project_terminal', { projectId }),
    openRepository: (projectId) => call('open_repository', { projectId }),

    pickDirectory: () =>
      guard(async () => {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false, title: 'Add project' });
        return typeof picked === 'string' ? picked : null;
      }),

    onOutput: (handler) => subscribe<OutputBatch>(EVENT_OUTPUT, handler),
    onRunState: (handler) => subscribe<RunMeta>(EVENT_RUN_STATE, handler),
    onWorkspaceChanged: (handler) => subscribe<Workspace>(EVENT_WORKSPACE, handler),
  };
}
