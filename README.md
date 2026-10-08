# DEVSPACE

DevWorkspace is a local-first desktop application for operating several local projects from
one window. You register project folders; it reads each one's real state from disk — Git
branch and working-tree status, the marker files and lockfile that identify the ecosystem,
the scripts the project defines — and gives you one place to run that project's commands,
watch their output stream in, cancel them, and open the project in your editor, file
manager, terminal or browser. Everything is stored in a single JSON file on your machine.
There are no accounts, no cloud sync, and no network calls.

## Features

**Projects.** Add a folder with the native picker or by typing a path. Rename it, pin it,
set its repository URL, or remove it from DevWorkspace without touching anything on disk.
Projects, their configured commands, settings and activity persist across restarts.

**Detection.** Each project is probed for marker files — `package.json`, `Cargo.toml`,
`pyproject.toml`, `requirements.txt`, `go.mod`, `deno.json(c)`, `composer.json`, `Gemfile`,
`pom.xml`, `build.gradle(.kts)`, `Makefile`, `justfile`, `Dockerfile`,
`docker-compose.yml` — and the package manager is inferred from the lockfile (`pnpm`,
`yarn`, `bun`, `npm`). `package.json` scripts are read and offered as commands.

**Git status.** Branch, short HEAD, upstream, ahead/behind counts, and staged, unstaged,
untracked and conflicted file counts, plus a concise changed-file list. Read by running
`git status --porcelain=v2 --branch`; if `git` is not on `PATH` the panel reports the
status as unavailable rather than failing.

**Command runner.** Commands run in the project's own directory through the platform shell
(`cmd.exe /S /C` on Windows, `/bin/sh -c` elsewhere). stdout and stderr stream in
separately while the process runs, the exit code is reported when it ends, and a run can be
cancelled — cancellation signals the whole process tree. Optionally limited to one run per
project at a time.

**Output panel.** Monospace output with stdout, stderr and system lines distinguished;
optional timestamps; follow-the-tail that yields as soon as you scroll up; copy and clear;
one tab per run; resizable and collapsible; configurable scrollback limit.

**Command palette.** `Ctrl`/`⌘`+`K` opens a single ranked list over projects, the selected
project's commands, and app actions, with fuzzy matching, match highlighting, and full
keyboard selection.

**Quick actions.** Open in editor, open folder, open terminal, and open repository. Editors
are detected on `PATH` from a known set — VS Code, VS Code Insiders, Cursor, Windsurf, Zed,
Sublime Text, IntelliJ IDEA, WebStorm — with a custom command as a fallback. Only actions
that are actually possible are shown; repository URLs are restricted to `http`/`https`.

**Activity log.** Commands run, projects opened and quick actions taken are recorded, kept
between sessions, and can be cleared.

**Settings.** Theme (Midnight, Graphite), accent (Ember, Sage, Steel), density, motion
preference, terminal font size, scrollback limit, follow-output, timestamps, default editor
and custom editor command, one-run-per-project, Git status refresh interval, and storage
details with a shortcut to the data folder.

**Keyboard and accessibility.** `Ctrl`/`⌘`+`K` palette, `Ctrl`/`⌘`+`B` sidebar,
`Ctrl`/`⌘`+`,` settings, `Ctrl`/`⌘`+`1`–`9` to jump to a project by position, and
arrow-key navigation in the project list. Dialogs trap focus, close on `Escape` and restore
focus to whatever opened them. Reduced-motion preferences are respected.

## Tech Stack

**Frontend** — React 19 with TypeScript 5.7 in strict mode, Zustand 5 for state, and
`lucide-react` for icons. Styling is hand-written CSS in three layers (design tokens, base
and typography, then components) with no CSS framework. The typefaces are Archivo
(display), Instrument Sans (UI) and JetBrains Mono (code and output), self-hosted as
variable fonts via `@fontsource-variable` so the app renders with no network access.

**Native** — Rust (edition 2021) on Tauri 2, with `tauri-plugin-dialog` for the folder
picker, `serde`/`serde_json` for the wire format and persistence, `thiserror` for errors
and `uuid` for identifiers. The frontend reaches it through 23 Tauri commands behind a
single typed IPC module.

**Build tooling** — Vite 6, `@vitejs/plugin-react`, ESLint 9 with `typescript-eslint` and
`eslint-plugin-react-hooks`, and Prettier 3.

**Testing** — Vitest 5 with jsdom and React Testing Library on the frontend; the built-in
Rust test harness with `tempfile` on the native side.

## Development

Install dependencies:

```bash
npm install
```

Run the desktop app in development — this starts Vite and the Rust side together, with
hot reload for the frontend:

```bash
npm run app
```

Run the frontend on its own in a browser. There is no native backend in this mode, so
projects, Git state and command output are simulated by an in-memory client and the app
shows a banner saying so:

```bash
npm run dev
```

Run the full verification suite:

```bash
npm run verify
```

Individual checks are also available: `npm run test` (or `test:watch`), `npm run typecheck`,
`npm run lint`, `npm run format` / `format:check`, `npm run rust:test`,
`npm run rust:clippy` and `npm run rust:fmt:check`.

Build the application. The first produces just the executable, the second produces the
platform installers:

```bash
npm run app:build
```

```bash
npm run app:bundle
```

`npm run build` builds only the frontend bundle into `dist/`, after a typecheck.

## Project Structure

```
src/                     frontend
  main.tsx               entry point; loads fonts and stylesheets
  App.tsx                shell: boot, appearance attributes, shortcuts, overlays
  components/            panels, dialogs and UI primitives (ui.tsx)
  lib/
    types.ts             the wire contract, mirroring src-tauri/src/model.rs
    ipc.ts               typed Tauri client boundary
    demo.ts              in-memory client used by tests and browser preview
    fuzzy.ts             palette matching and ranking
    format.ts            duration, size, path and time formatting
  state/store.ts         the single Zustand store
  styles/                tokens.css, base.css, app.css
  test/setup.ts          jsdom shims for the test environment

src-tauri/               native side
  src/
    lib.rs               app setup and command registration
    commands.rs          the Tauri command layer
    model.rs             serde types shared with the frontend
    store.rs             JSON file persistence
    detect.rs            ecosystem and script detection
    git.rs               porcelain v2 parsing
    runner.rs            process execution, streaming and cancellation
    system.rs            shells, editors, folders, terminals and URLs
    error.rs             structured errors
  capabilities/          Tauri permission allowlist
  tauri.conf.json        window, bundle and CSP configuration

scripts/make-icon.mjs    regenerates the app icon source
index.html               Vite entry document
vite.config.ts           Vite and Vitest configuration
```

## Testing & Verification

`npm run verify` runs the whole gate in order and stops at the first failure:

| Step             | Checks                                    |
| ---------------- | ----------------------------------------- |
| `format:check`   | Prettier over `src/**/*.{ts,tsx,css}`     |
| `lint`           | ESLint over the TypeScript sources        |
| `typecheck`      | `tsc --noEmit`                            |
| `test`           | 139 frontend tests (Vitest, jsdom)        |
| `rust:fmt:check` | `cargo fmt --check`                       |
| `rust:test`      | 102 Rust tests                            |
| `build`          | typecheck, then the production Vite build |

The frontend tests cover the pure utilities (`fuzzy`, `format`), the store's behaviour
against a stub client — boot and boot failure, project add/remove/update, command
add/edit/remove, running, failure, cancellation, output trimming, settings persistence and
restart, toasts, overlays and selectors — the command palette, and the application shell
including its boot states, shortcuts, responsive sidebar and overlays.

The Rust tests cover the process runner, detection, porcelain parsing, the platform layer,
the command layer, persistence, the shared model and error classification.

Two checks are configured but deliberately not part of `verify`: `npm run rust:clippy`
(which runs with `-D warnings`) and the Tauri application build. Run both before
publishing a release.

Note that jsdom has no layout engine, so the test suite cannot catch CSS layout
regressions; those need to be checked in a real browser or in the app.

## Platform / Development Notes

- **Rust 1.77 or newer** is required (`rust-version` in `src-tauri/Cargo.toml`), along with
  the usual Tauri 2 system prerequisites for your platform, including the platform webview
  — WebView2 on Windows.
- **Node.js** `^18`, `^20` or `>=22`, as required by Vite 6.
- **`git` on `PATH`** is needed for the Git panel. Without it the app still works and
  reports Git status as unavailable.
- The dev server is pinned to **port 5173** with `strictPort`, because `tauri.conf.json`
  points `devUrl` at it. The port must be free before `npm run app`.
- Vite's file watcher is configured to ignore `src-tauri/**`. Watching the Rust build
  output breaks the dev server, because Cargo holds an exclusive lock on the binary it is
  linking.
- Data is stored in a single `workspace.json` in the platform config directory for the
  `studio.devworkspace.app` identifier. Deleting it resets DevWorkspace; your project
  folders are untouched.
- The window ships a restrictive CSP, `withGlobalTauri` is off, and the capability
  allowlist grants only `core:default` and `dialog:allow-open`.
- Commands you configure are executed through the platform shell. The command line is
  shown next to every command in the list, and the directory it will run in is shown in the
  project header and in the command editor.
- `.gitattributes` normalises line endings to LF on checkout, so that Prettier's `lf`
  default and `format:check` agree with Git on Windows.
- The app icon is generated: `node scripts/make-icon.mjs` redraws
  `scripts/icon-source.png`, then
  `npx tauri icon scripts/icon-source.png -o src-tauri/icons` regenerates the icon set.
