/**
 * An in-memory `WorkspaceClient`.
 *
 * Used by the test suite, and by `npm run dev` in a plain browser so the
 * interface can be worked on without launching the desktop shell. It is
 * explicit about not being native — the UI shows a banner in that mode and
 * never presents its numbers as real system state.
 */

import type { Unsubscribe, WorkspaceClient } from './ipc';
import {
  DEFAULT_SETTINGS,
  EMPTY_WORKSPACE,
  type ActivityEntry,
  type ActivityInput,
  type AddProjectResult,
  type CommandDef,
  type CommandKind,
  type Detection,
  type EditorInfo,
  type GitStatus,
  type OutputBatch,
  type OutputLine,
  type Project,
  type ProjectPatch,
  type ProjectStatus,
  type RunMeta,
  type Settings,
  type StorageInfo,
  type Workspace,
} from './types';

export interface DemoClientOptions {
  /** Persist between reloads. Pass null for a throwaway client. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Seed a few projects so the UI has something to show. */
  seed?: boolean;
  /** Delay between simulated output batches, in milliseconds. */
  tickMs?: number;
}

const STORAGE_KEY = 'devworkspace.demo.v1';

let counter = 0;
const id = (prefix: string) =>
  `${prefix}_${(counter += 1).toString(36)}${Date.now().toString(36)}`;

function command(label: string, program: string, kind: CommandKind): CommandDef {
  return { id: id('cmd'), label, program, kind, source: 'detected' };
}

function seedProjects(): Project[] {
  const now = Date.now();
  return [
    {
      id: 'prj_demo_zarchat',
      name: 'ZARChat',
      path: 'C:\\code\\zarchat',
      favorite: true,
      repositoryUrl: 'https://github.com/example/zarchat',
      commands: [
        command('Dev', 'npm run dev', 'dev'),
        command('Test', 'npm test', 'test'),
        command('Build', 'npm run build', 'build'),
      ],
      createdAt: now - 86_400_000 * 12,
      updatedAt: now - 3_600_000,
      lastOpenedAt: now - 3_600_000,
    },
    {
      id: 'prj_demo_lumen',
      name: 'LUMEN',
      path: 'C:\\code\\lumen',
      favorite: false,
      repositoryUrl: null,
      commands: [command('Run', 'cargo run', 'dev'), command('Test', 'cargo test', 'test')],
      createdAt: now - 86_400_000 * 40,
      updatedAt: now - 86_400_000,
      lastOpenedAt: now - 86_400_000,
    },
    {
      id: 'prj_demo_api',
      name: 'Atlas API',
      path: 'C:\\code\\atlas-api',
      favorite: false,
      repositoryUrl: null,
      commands: [command('Test', 'go test ./...', 'test')],
      createdAt: now - 86_400_000 * 3,
      updatedAt: now - 86_400_000 * 3,
      lastOpenedAt: null,
    },
  ];
}

function detectionFor(project: Project): Detection {
  if (project.commands.some((c) => c.program.startsWith('cargo'))) {
    return {
      markers: ['Cargo.toml', '.git'],
      ecosystems: ['rust'],
      primaryLanguage: 'Rust',
      packageManager: null,
      projectType: 'Rust binary',
      scripts: [],
      hasGit: true,
      suggested: [],
    };
  }
  if (project.commands.some((c) => c.program.startsWith('go'))) {
    return {
      markers: ['go.mod'],
      ecosystems: ['go'],
      primaryLanguage: 'Go',
      packageManager: null,
      projectType: 'Go module',
      scripts: [],
      hasGit: false,
      suggested: [],
    };
  }
  return {
    markers: ['package.json', '.git'],
    ecosystems: ['node'],
    primaryLanguage: 'TypeScript / JavaScript',
    packageManager: 'npm',
    projectType: 'Vite · React',
    scripts: [
      { name: 'dev', command: 'vite' },
      { name: 'test', command: 'vitest' },
      { name: 'build', command: 'vite build' },
    ],
    hasGit: true,
    suggested: [],
  };
}

function gitFor(project: Project): GitStatus {
  if (project.id === 'prj_demo_api') {
    return { ...emptyGit(), available: true, isRepo: false, clean: true };
  }
  if (project.id === 'prj_demo_lumen') {
    return {
      ...emptyGit(),
      available: true,
      isRepo: true,
      branch: 'main',
      headShort: 'c41d9f2',
      upstream: 'origin/main',
      clean: true,
    };
  }
  return {
    ...emptyGit(),
    available: true,
    isRepo: true,
    branch: 'feat/thread-presence',
    headShort: '9b2e7a1',
    upstream: 'origin/feat/thread-presence',
    ahead: 2,
    behind: 1,
    staged: 2,
    unstaged: 3,
    untracked: 1,
    clean: false,
    totalChanged: 6,
    files: [
      {
        path: 'src/app/thread.tsx',
        code: 'M.',
        kind: 'modified',
        staged: true,
        unstaged: false,
      },
      { path: 'src/lib/presence.ts', code: 'A.', kind: 'added', staged: true, unstaged: false },
      {
        path: 'src/app/shell.tsx',
        code: '.M',
        kind: 'modified',
        staged: false,
        unstaged: true,
      },
      {
        path: 'src/styles/base.css',
        code: '.M',
        kind: 'modified',
        staged: false,
        unstaged: true,
      },
      { path: 'README.md', code: '.M', kind: 'modified', staged: false, unstaged: true },
      { path: 'notes.local.md', code: '??', kind: 'untracked', staged: false, unstaged: true },
    ],
  };
}

function emptyGit(): GitStatus {
  return {
    isRepo: false,
    available: false,
    branch: null,
    headShort: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    clean: true,
    files: [],
    truncated: false,
    totalChanged: 0,
  };
}

/** Output a simulated run produces, so the terminal has something lifelike. */
const SCRIPT: Array<[OutputLine['stream'], string]> = [
  ['stdout', ''],
  ['stdout', '  ✓ src/lib/fuzzy.test.ts (14 tests) 23ms'],
  ['stdout', '  ✓ src/lib/format.test.ts (11 tests) 9ms'],
  ['stdout', '  ✓ src/state/store.test.ts (18 tests) 212ms'],
  ['stderr', '  stderr | one deprecation notice'],
  ['stdout', ''],
  ['stdout', '  Test Files  3 passed (3)'],
  ['stdout', '       Tests  43 passed (43)'],
];

export function createDemoClient(options: DemoClientOptions = {}): WorkspaceClient {
  const { seed = true, tickMs = 120 } = options;
  const storage =
    options.storage === undefined
      ? typeof localStorage === 'undefined'
        ? null
        : localStorage
      : options.storage;

  let workspace: Workspace = load();
  const outputHandlers = new Set<(batch: OutputBatch) => void>();
  const stateHandlers = new Set<(meta: RunMeta) => void>();
  const workspaceHandlers = new Set<(workspace: Workspace) => void>();
  const live = new Map<string, { meta: RunMeta; timers: ReturnType<typeof setTimeout>[] }>();

  function load(): Workspace {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Workspace;
        return {
          ...EMPTY_WORKSPACE,
          ...parsed,
          settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
        };
      } catch {
        // A corrupt demo document is not worth recovering.
      }
    }
    return {
      ...EMPTY_WORKSPACE,
      projects: seed ? seedProjects() : [],
      lastProjectId: seed ? 'prj_demo_zarchat' : null,
    };
  }

  function persist() {
    storage?.setItem(STORAGE_KEY, JSON.stringify(workspace));
  }

  function commit(next: Workspace) {
    workspace = next;
    persist();
  }

  function pushActivity(entry: ActivityInput) {
    const record: ActivityEntry = {
      id: id('act'),
      kind: entry.kind,
      level: entry.level ?? 'info',
      projectId: entry.projectId ?? null,
      title: entry.title,
      detail: entry.detail ?? null,
      at: Date.now(),
    };
    commit({ ...workspace, activity: [record, ...workspace.activity].slice(0, 250) });
  }

  function find(projectId: string): Project {
    const project = workspace.projects.find((p) => p.id === projectId);
    if (!project) {
      throw { code: 'PROJECT_NOT_FOUND', message: `Unknown project \`${projectId}\`.` };
    }
    return project;
  }

  function replace(project: Project): Project {
    commit({
      ...workspace,
      projects: workspace.projects.map((p) => (p.id === project.id ? project : p)),
    });
    return project;
  }

  function notNative(action: string): never {
    throw {
      code: 'NOT_AVAILABLE',
      message: `${action} needs the desktop app.`,
      hint: 'Run DevWorkspace with `npm run app` to use system actions.',
    };
  }

  function finish(runId: string, status: RunMeta['status'], exitCode: number | null) {
    const entry = live.get(runId);
    if (!entry) return;
    entry.timers.forEach(clearTimeout);
    live.delete(runId);

    const meta: RunMeta = { ...entry.meta, status, exitCode, finishedAt: Date.now() };
    const elapsed = (meta.finishedAt ?? 0) - meta.startedAt;
    outputHandlers.forEach((handler) =>
      handler({
        runId,
        lines: [
          {
            seq: 999,
            stream: 'system',
            text:
              status === 'cancelled'
                ? `— cancelled after ${elapsed}ms`
                : status === 'succeeded'
                  ? `— finished in ${elapsed}ms`
                  : `— exited with code ${exitCode ?? '?'}`,
            at: Date.now(),
          },
        ],
      }),
    );
    commit({
      ...workspace,
      history: [
        {
          id: id('hist'),
          projectId: meta.projectId,
          label: meta.label,
          command: meta.command,
          at: meta.startedAt,
          durationMs: elapsed,
          exitCode,
          status,
        },
        ...workspace.history,
      ].slice(0, 120),
    });
    stateHandlers.forEach((handler) => handler(meta));
    workspaceHandlers.forEach((handler) => handler(workspace));
  }

  const subscribe = <T>(set: Set<(payload: T) => void>, handler: (payload: T) => void) => {
    set.add(handler);
    return (() => set.delete(handler)) as Unsubscribe;
  };

  return {
    native: false,

    loadWorkspace: async () => workspace,

    addProject: async (path, name): Promise<AddProjectResult> => {
      const normalized = path.trim().replace(/[/\\]+$/, '');
      if (!normalized) {
        throw { code: 'PATH_NOT_FOUND', message: 'That path is empty.' };
      }
      if (workspace.projects.some((p) => p.path.toLowerCase() === normalized.toLowerCase())) {
        throw {
          code: 'PROJECT_EXISTS',
          message: 'That folder is already in DevWorkspace.',
          hint: 'Select it in the sidebar, or pick a different folder.',
        };
      }
      const now = Date.now();
      const project: Project = {
        id: id('prj'),
        name: name?.trim() || normalized.split(/[/\\]/).filter(Boolean).pop() || 'Project',
        path: normalized,
        favorite: false,
        repositoryUrl: null,
        commands: [command('Test', 'npm test', 'test')],
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
      };
      commit({
        ...workspace,
        projects: [...workspace.projects, project],
        lastProjectId: project.id,
      });
      pushActivity({
        kind: 'projectAdded',
        level: 'success',
        projectId: project.id,
        title: `Added ${project.name}`,
      });
      return { project, detection: detectionFor(project) };
    },

    removeProject: async (projectId) => {
      const project = find(projectId);
      commit({
        ...workspace,
        projects: workspace.projects.filter((p) => p.id !== projectId),
        lastProjectId:
          workspace.lastProjectId === projectId
            ? (workspace.projects.find((p) => p.id !== projectId)?.id ?? null)
            : workspace.lastProjectId,
      });
      pushActivity({ kind: 'projectRemoved', title: `Removed ${project.name}` });
      return workspace;
    },

    updateProject: async (projectId, patch: ProjectPatch) => {
      const project = find(projectId);
      if (patch.name !== undefined && !patch.name.trim()) {
        throw { code: 'EMPTY_NAME', message: 'A project needs a name.' };
      }
      if (patch.repositoryUrl) {
        const url = patch.repositoryUrl.trim();
        if (!/^https?:\/\/.+/i.test(url)) {
          throw {
            code: 'UNSUPPORTED_URL',
            message: 'Only http and https links can be opened.',
            hint: 'Use the full web address, for example https://github.com/you/project.',
          };
        }
      }
      return replace({
        ...project,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.path !== undefined ? { path: patch.path } : {}),
        ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}),
        ...(patch.repositoryUrl !== undefined
          ? { repositoryUrl: patch.repositoryUrl?.trim() || null }
          : {}),
        updatedAt: Date.now(),
      });
    },

    setLastProject: async (projectId) => {
      commit({
        ...workspace,
        lastProjectId: projectId,
        projects: workspace.projects.map((p) =>
          p.id === projectId ? { ...p, lastOpenedAt: Date.now() } : p,
        ),
      });
    },

    addCommand: async (projectId, label, program, kind) => {
      const project = find(projectId);
      if (!program.trim()) throw { code: 'EMPTY_COMMAND', message: 'That command is empty.' };
      return replace({
        ...project,
        commands: [
          ...project.commands,
          {
            id: id('cmd'),
            label: label.trim() || program.trim().split(/\s+/)[0] || 'Command',
            program: program.trim(),
            kind,
            source: 'manual',
          },
        ],
        updatedAt: Date.now(),
      });
    },

    updateCommand: async (projectId, commandId, label, program, kind) => {
      const project = find(projectId);
      if (!program.trim()) throw { code: 'EMPTY_COMMAND', message: 'That command is empty.' };
      return replace({
        ...project,
        commands: project.commands.map((c) =>
          c.id === commandId
            ? {
                ...c,
                label: label.trim() || c.label,
                program: program.trim(),
                kind,
                source: 'manual',
              }
            : c,
        ),
        updatedAt: Date.now(),
      });
    },

    removeCommand: async (projectId, commandId) => {
      const project = find(projectId);
      return replace({
        ...project,
        commands: project.commands.filter((c) => c.id !== commandId),
        updatedAt: Date.now(),
      });
    },

    syncDetectedCommands: async (projectId) => find(projectId),

    projectStatus: async (projectId): Promise<ProjectStatus> => {
      const project = find(projectId);
      return {
        projectId,
        exists: true,
        checkedAt: Date.now(),
        detection: detectionFor(project),
        git: gitFor(project),
      };
    },

    runCommand: async (projectId, label, program) => {
      const project = find(projectId);
      if (
        workspace.settings.singleRunPerProject &&
        [...live.values()].some((entry) => entry.meta.projectId === projectId)
      ) {
        throw {
          code: 'ALREADY_RUNNING',
          message: `A command is already running in ${project.name}.`,
          hint: 'Stop it first, or allow several at once in Settings → Command behaviour.',
        };
      }

      const meta: RunMeta = {
        runId: id('run'),
        projectId,
        projectName: project.name,
        label,
        command: program,
        cwd: project.path,
        startedAt: Date.now(),
        finishedAt: null,
        exitCode: null,
        status: 'running',
      };
      const timers: ReturnType<typeof setTimeout>[] = [];
      live.set(meta.runId, { meta, timers });

      outputHandlers.forEach((handler) =>
        handler({
          runId: meta.runId,
          lines: [
            { seq: 0, stream: 'system', text: `$ ${program}`, at: Date.now() },
            { seq: 1, stream: 'system', text: `  in ${project.path}`, at: Date.now() },
          ],
        }),
      );
      stateHandlers.forEach((handler) => handler(meta));

      SCRIPT.forEach(([stream, text], index) => {
        timers.push(
          setTimeout(
            () =>
              outputHandlers.forEach((handler) =>
                handler({
                  runId: meta.runId,
                  lines: [{ seq: index + 2, stream, text, at: Date.now() }],
                }),
              ),
            tickMs * (index + 1),
          ),
        );
      });
      timers.push(
        setTimeout(() => finish(meta.runId, 'succeeded', 0), tickMs * (SCRIPT.length + 1)),
      );
      return meta;
    },

    cancelRun: async (runId) => {
      const entry = live.get(runId);
      if (!entry) {
        throw {
          code: 'RUN_NOT_FOUND',
          message: 'That command has already finished.',
        };
      }
      const meta = entry.meta;
      finish(runId, 'cancelled', null);
      return meta;
    },

    activeRuns: async () => [...live.values()].map((entry) => entry.meta),

    saveSettings: async (settings: Settings) => {
      const sanitized: Settings = {
        ...settings,
        terminalFontSize: Math.min(20, Math.max(10, settings.terminalFontSize)),
        maxOutputLines: Math.min(100_000, Math.max(500, settings.maxOutputLines)),
      };
      commit({ ...workspace, settings: sanitized });
      return sanitized;
    },

    logActivity: async (entry) => pushActivity(entry),

    clearActivity: async () => {
      commit({ ...workspace, activity: [], history: [] });
      return workspace;
    },

    storageInfo: async (): Promise<StorageInfo> => ({
      path: '(browser preview — not saved to disk)',
      sizeBytes: JSON.stringify(workspace).length,
      projectCount: workspace.projects.length,
      activityCount: workspace.activity.length,
      historyCount: workspace.history.length,
    }),

    revealStorage: async () => notNative('Opening the data folder'),
    availableEditors: async (): Promise<EditorInfo[]> => [],

    openInEditor: async () => notNative('Opening an editor'),
    openFolder: async () => notNative('Opening a folder'),
    openTerminal: async () => notNative('Opening a terminal'),
    openRepository: async () => notNative('Opening a browser'),
    pickDirectory: async () => null,

    onOutput: (handler) => subscribe(outputHandlers, handler),
    onRunState: (handler) => subscribe(stateHandlers, handler),
    onWorkspaceChanged: (handler) => subscribe(workspaceHandlers, handler),
  };
}
