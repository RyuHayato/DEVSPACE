/**
 * The wire contract with the Rust backend.
 *
 * Every type here mirrors a `serde` struct in `src-tauri/src/model.rs`, which
 * serialises as camelCase. Keeping these in one file makes the boundary easy
 * to audit when the Rust side changes.
 */

export type CommandKind = 'dev' | 'test' | 'build' | 'lint' | 'install' | 'custom';
export type CommandSource = 'detected' | 'manual';

export interface CommandDef {
  id: string;
  label: string;
  /** The full command line, run through the platform shell. */
  program: string;
  kind: CommandKind;
  source: CommandSource;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  favorite: boolean;
  repositoryUrl: string | null;
  commands: CommandDef[];
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
}

export interface ProjectPatch {
  name?: string;
  path?: string;
  favorite?: boolean;
  /** `null` clears the URL; omitting the key leaves it untouched. */
  repositoryUrl?: string | null;
}

export interface ScriptEntry {
  name: string;
  command: string;
}

export interface Detection {
  markers: string[];
  ecosystems: string[];
  primaryLanguage: string | null;
  packageManager: string | null;
  projectType: string | null;
  scripts: ScriptEntry[];
  hasGit: boolean;
  suggested: CommandDef[];
}

export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechanged';

export interface GitFile {
  path: string;
  code: string;
  kind: ChangeKind;
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  /** False when `git` is not installed or not on PATH. */
  available: boolean;
  branch: string | null;
  headShort: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  clean: boolean;
  files: GitFile[];
  truncated: boolean;
  totalChanged: number;
}

export interface AppError {
  code: string;
  message: string;
  hint?: string;
}

export interface ProjectStatus {
  projectId: string;
  exists: boolean;
  checkedAt: number;
  detection: Detection;
  git: GitStatus;
  error?: AppError;
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'error';
export type OutputStream = 'stdout' | 'stderr' | 'system';

export interface RunMeta {
  runId: string;
  projectId: string;
  projectName: string;
  label: string;
  command: string;
  cwd: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  status: RunStatus;
  error?: AppError;
}

export interface OutputLine {
  seq: number;
  stream: OutputStream;
  text: string;
  at: number;
}

export interface OutputBatch {
  runId: string;
  lines: OutputLine[];
}

export interface HistoryEntry {
  id: string;
  projectId: string;
  label: string;
  command: string;
  at: number;
  durationMs: number;
  exitCode: number | null;
  status: RunStatus;
}

export type ActivityKind =
  | 'commandRun'
  | 'projectAdded'
  | 'projectRemoved'
  | 'projectUpdated'
  | 'projectOpened'
  | 'statusChanged'
  | 'actionRun'
  | 'problem';

export type ActivityLevel = 'info' | 'success' | 'warn' | 'error';

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  level: ActivityLevel;
  projectId: string | null;
  title: string;
  detail: string | null;
  at: number;
}

export interface ActivityInput {
  kind: ActivityKind;
  level?: ActivityLevel;
  projectId?: string | null;
  title: string;
  detail?: string | null;
}

export type Theme = 'midnight' | 'graphite';
export type Accent = 'ember' | 'sage' | 'steel';
export type Density = 'comfortable' | 'compact';
export type MotionPref = 'system' | 'reduced' | 'full';

export interface Settings {
  theme: Theme;
  accent: Accent;
  density: Density;
  motion: MotionPref;
  terminalFontSize: number;
  editor: string;
  customEditorCommand: string | null;
  confirmBeforeRun: boolean;
  singleRunPerProject: boolean;
  autoScrollOutput: boolean;
  showTimestamps: boolean;
  maxOutputLines: number;
  /** Seconds between background status refreshes; 0 means manual only. */
  statusRefreshSeconds: number;
}

export interface Workspace {
  version: number;
  projects: Project[];
  settings: Settings;
  activity: ActivityEntry[];
  history: HistoryEntry[];
  lastProjectId: string | null;
}

export interface EditorInfo {
  id: string;
  label: string;
  command: string;
  available: boolean;
}

export interface StorageInfo {
  path: string;
  sizeBytes: number;
  projectCount: number;
  activityCount: number;
  historyCount: number;
}

export interface AddProjectResult {
  project: Project;
  detection: Detection;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'midnight',
  accent: 'ember',
  density: 'comfortable',
  motion: 'system',
  terminalFontSize: 12,
  editor: 'code',
  customEditorCommand: null,
  confirmBeforeRun: false,
  singleRunPerProject: true,
  autoScrollOutput: true,
  showTimestamps: false,
  maxOutputLines: 5000,
  statusRefreshSeconds: 30,
};

export const EMPTY_WORKSPACE: Workspace = {
  version: 1,
  projects: [],
  settings: DEFAULT_SETTINGS,
  activity: [],
  history: [],
  lastProjectId: null,
};
