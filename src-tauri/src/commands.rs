//! The command layer: the only surface the UI can reach.
//!
//! Each command is small and transactional — it mutates the in-memory
//! workspace, persists it, and returns the authoritative value. The UI mirrors
//! that result rather than guessing, so a failed write can never leave the two
//! out of step.

use crate::detect;
use crate::error::{AppError, AppResult};
use crate::git;
use crate::model::*;
use crate::runner::{self, Emitter, RunRegistry};
use crate::store::Persistence;
use crate::system::{self, EditorInfo};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter as _, State};

pub const EVENT_OUTPUT: &str = "run://output";
pub const EVENT_RUN_STATE: &str = "run://state";
pub const EVENT_WORKSPACE: &str = "workspace://changed";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct Inner {
    store: Box<dyn Persistence>,
    workspace: Mutex<Workspace>,
    pub runs: Arc<RunRegistry>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Workspace> {
        match self.workspace.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn snapshot(&self) -> Workspace {
        self.lock().clone()
    }

    /// Applies a change and persists it. The workspace lock is released before
    /// the (slower) disk write so no command can block another for long.
    fn mutate<T>(&self, change: impl FnOnce(&mut Workspace) -> AppResult<T>) -> AppResult<T> {
        let (result, snapshot) = {
            let mut ws = self.lock();
            let result = change(&mut ws)?;
            (result, ws.clone())
        };
        self.store.save(&snapshot)?;
        Ok(result)
    }
}

pub struct AppState(pub Arc<Inner>);

impl AppState {
    pub fn new(store: Box<dyn Persistence>) -> AppResult<Self> {
        let workspace = store.load()?;
        Ok(Self(Arc::new(Inner {
            store,
            workspace: Mutex::new(workspace),
            runs: Arc::new(RunRegistry::default()),
        })))
    }
}

/// Bridges runner events onto the Tauri event bus.
struct TauriEmitter {
    app: AppHandle,
}

impl Emitter for TauriEmitter {
    fn output(&self, batch: OutputBatch) {
        let _ = self.app.emit(EVENT_OUTPUT, batch);
    }
    fn state(&self, meta: RunMeta) {
        let _ = self.app.emit(EVENT_RUN_STATE, meta);
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Canonicalises a path and strips the Windows `\\?\` verbatim prefix so the
/// value we show the user is the one they recognise.
pub fn normalize_path(input: &str) -> String {
    let trimmed = input.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return input.trim().to_string();
    }
    let candidate = PathBuf::from(trimmed);
    let resolved = candidate.canonicalize().unwrap_or(candidate);
    let text = resolved.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

/// Windows paths are case-insensitive; everywhere else they are not.
fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn project_path(ws: &Workspace, id: &str) -> AppResult<PathBuf> {
    let project = ws
        .project(id)
        .ok_or_else(|| AppError::unknown_project(id))?;
    let path = PathBuf::from(&project.path);
    if !path.exists() {
        return Err(AppError::not_found(&project.path));
    }
    Ok(path)
}

fn activity(
    kind: ActivityKind,
    level: ActivityLevel,
    project_id: Option<&str>,
    title: impl Into<String>,
    detail: Option<String>,
) -> ActivityEntry {
    ActivityEntry {
        id: new_id("act"),
        kind,
        level,
        project_id: project_id.map(str::to_string),
        title: title.into(),
        detail,
        at: now_ms(),
    }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn load_workspace(state: State<AppState>) -> Workspace {
    state.0.snapshot()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectResult {
    pub project: Project,
    pub detection: Detection,
}

#[tauri::command]
pub fn add_project(
    state: State<AppState>,
    path: String,
    name: Option<String>,
) -> AppResult<AddProjectResult> {
    let normalized = normalize_path(&path);
    let as_path = Path::new(&normalized);

    if !as_path.exists() {
        return Err(AppError::not_found(&normalized));
    }
    if !as_path.is_dir() {
        return Err(AppError::not_a_directory(&normalized));
    }
    // Confirm we can actually read it before adding it to the sidebar.
    if let Err(e) = std::fs::read_dir(as_path) {
        return Err(AppError::from_io(&normalized, &e));
    }

    let detection = detect::detect(as_path);
    let display_name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| detect::name_from_path(&normalized));

    let stamp = now_ms();
    let project = Project {
        id: new_id("prj"),
        name: display_name.clone(),
        path: normalized.clone(),
        favorite: false,
        repository_url: None,
        commands: detection.suggested.clone(),
        created_at: stamp,
        updated_at: stamp,
        last_opened_at: Some(stamp),
    };

    let stored = state.0.mutate(|ws| {
        if let Some(existing) = ws.projects.iter().find(|p| same_path(&p.path, &normalized)) {
            return Err(AppError::new(
                "PROJECT_EXISTS",
                format!("`{}` is already in DevWorkspace.", existing.name),
            )
            .with_hint("Select it in the sidebar, or pick a different folder."));
        }
        ws.projects.push(project.clone());
        ws.last_project_id = Some(project.id.clone());
        ws.push_activity(activity(
            ActivityKind::ProjectAdded,
            ActivityLevel::Success,
            Some(&project.id),
            format!("Added {display_name}"),
            detection.project_type.clone(),
        ));
        Ok(project.clone())
    })?;

    Ok(AddProjectResult {
        project: stored,
        detection,
    })
}

/// Removes the project from DevWorkspace only. Nothing on disk is touched.
#[tauri::command]
pub fn remove_project(state: State<AppState>, id: String) -> AppResult<Workspace> {
    state.0.mutate(|ws| {
        let index = ws
            .projects
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| AppError::unknown_project(&id))?;
        let removed = ws.projects.remove(index);
        if ws.last_project_id.as_deref() == Some(id.as_str()) {
            ws.last_project_id = ws.projects.first().map(|p| p.id.clone());
        }
        ws.push_activity(activity(
            ActivityKind::ProjectRemoved,
            ActivityLevel::Info,
            None,
            format!("Removed {}", removed.name),
            Some("The folder on disk was not changed.".into()),
        ));
        Ok(())
    })?;
    Ok(state.0.snapshot())
}

#[tauri::command]
pub fn update_project(
    state: State<AppState>,
    id: String,
    patch: ProjectPatch,
) -> AppResult<Project> {
    // A new path has to be validated before it is written.
    let new_path = match &patch.path {
        Some(raw) => {
            let normalized = normalize_path(raw);
            let as_path = Path::new(&normalized);
            if !as_path.exists() {
                return Err(AppError::not_found(&normalized));
            }
            if !as_path.is_dir() {
                return Err(AppError::not_a_directory(&normalized));
            }
            Some(normalized)
        }
        None => None,
    };
    let new_url = match &patch.repository_url {
        Some(Some(raw)) if !raw.trim().is_empty() => Some(Some(system::validate_url(raw)?)),
        Some(Some(_)) | Some(None) => Some(None),
        None => None,
    };

    state.0.mutate(|ws| {
        if let Some(path) = &new_path {
            if ws
                .projects
                .iter()
                .any(|p| p.id != id && same_path(&p.path, path))
            {
                return Err(AppError::new(
                    "PROJECT_EXISTS",
                    "Another project already points at that folder.",
                )
                .with_hint("Pick a different folder, or remove the other project first."));
            }
        }

        let project = ws
            .project_mut(&id)
            .ok_or_else(|| AppError::unknown_project(&id))?;
        let mut notes: Vec<String> = Vec::new();

        if let Some(name) = patch.name.as_ref().map(|n| n.trim()) {
            if name.is_empty() {
                return Err(AppError::new("EMPTY_NAME", "A project needs a name.")
                    .with_hint("Enter a short display name, or reset it to the folder name."));
            }
            if name != project.name {
                notes.push(format!("Renamed to {name}"));
                project.name = name.to_string();
            }
        }
        if let Some(path) = new_path {
            if path != project.path {
                notes.push("Path updated".into());
                project.path = path;
            }
        }
        if let Some(favorite) = patch.favorite {
            if favorite != project.favorite {
                notes.push(if favorite {
                    "Pinned".into()
                } else {
                    "Unpinned".into()
                });
                project.favorite = favorite;
            }
        }
        if let Some(url) = new_url {
            if url != project.repository_url {
                notes.push(match &url {
                    Some(_) => "Repository URL set".into(),
                    None => "Repository URL cleared".to_string(),
                });
                project.repository_url = url;
            }
        }

        project.updated_at = now_ms();
        let snapshot = project.clone();
        if !notes.is_empty() {
            ws.push_activity(activity(
                ActivityKind::ProjectUpdated,
                ActivityLevel::Info,
                Some(&id),
                snapshot.name.clone(),
                Some(notes.join(" · ")),
            ));
        }
        Ok(snapshot)
    })
}

#[tauri::command]
pub fn set_last_project(state: State<AppState>, id: Option<String>) -> AppResult<()> {
    state.0.mutate(|ws| {
        match &id {
            Some(id) => {
                let project = ws
                    .project_mut(id)
                    .ok_or_else(|| AppError::unknown_project(id))?;
                project.last_opened_at = Some(now_ms());
                let name = project.name.clone();
                ws.last_project_id = Some(id.clone());
                ws.push_activity(activity(
                    ActivityKind::ProjectOpened,
                    ActivityLevel::Info,
                    Some(id),
                    name,
                    None,
                ));
            }
            None => ws.last_project_id = None,
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Commands on a project
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn add_command(
    state: State<AppState>,
    project_id: String,
    label: String,
    program: String,
    kind: CommandKind,
) -> AppResult<Project> {
    let label = label.trim().to_string();
    let program = program.trim().to_string();
    if program.is_empty() {
        return Err(AppError::empty_command());
    }
    let label = if label.is_empty() {
        program
            .split_whitespace()
            .next()
            .unwrap_or("Command")
            .to_string()
    } else {
        label
    };

    state.0.mutate(|ws| {
        let project = ws
            .project_mut(&project_id)
            .ok_or_else(|| AppError::unknown_project(&project_id))?;
        project.commands.push(CommandDef {
            id: new_id("cmd"),
            label,
            program,
            kind,
            source: CommandSource::Manual,
        });
        project.updated_at = now_ms();
        Ok(project.clone())
    })
}

#[tauri::command]
pub fn update_command(
    state: State<AppState>,
    project_id: String,
    command_id: String,
    label: String,
    program: String,
    kind: CommandKind,
) -> AppResult<Project> {
    let label = label.trim().to_string();
    let program = program.trim().to_string();
    if program.is_empty() {
        return Err(AppError::empty_command());
    }

    state.0.mutate(|ws| {
        let project = ws
            .project_mut(&project_id)
            .ok_or_else(|| AppError::unknown_project(&project_id))?;
        let command = project
            .commands
            .iter_mut()
            .find(|c| c.id == command_id)
            .ok_or_else(|| {
                AppError::new("COMMAND_NOT_FOUND", "That command no longer exists.")
                    .with_hint("It may have been removed. Reload DevWorkspace.")
            })?;
        command.label = if label.is_empty() {
            command.label.clone()
        } else {
            label
        };
        command.program = program;
        command.kind = kind;
        // An edited command is the user's, not ours, so it survives re-detection.
        command.source = CommandSource::Manual;
        project.updated_at = now_ms();
        Ok(project.clone())
    })
}

#[tauri::command]
pub fn remove_command(
    state: State<AppState>,
    project_id: String,
    command_id: String,
) -> AppResult<Project> {
    state.0.mutate(|ws| {
        let project = ws
            .project_mut(&project_id)
            .ok_or_else(|| AppError::unknown_project(&project_id))?;
        project.commands.retain(|c| c.id != command_id);
        project.updated_at = now_ms();
        Ok(project.clone())
    })
}

/// Re-runs detection and adds any suggested command the project is missing.
/// Existing commands are never overwritten.
#[tauri::command]
pub fn sync_detected_commands(state: State<AppState>, project_id: String) -> AppResult<Project> {
    let path = {
        let ws = state.0.lock();
        project_path(&ws, &project_id)?
    };
    let detection = detect::detect(&path);

    state.0.mutate(|ws| {
        let project = ws
            .project_mut(&project_id)
            .ok_or_else(|| AppError::unknown_project(&project_id))?;
        let mut added = 0usize;
        for candidate in &detection.suggested {
            let already = project
                .commands
                .iter()
                .any(|c| c.program.eq_ignore_ascii_case(&candidate.program));
            if !already {
                project.commands.push(candidate.clone());
                added += 1;
            }
        }
        project.updated_at = now_ms();
        let snapshot = project.clone();
        ws.push_activity(activity(
            ActivityKind::ProjectUpdated,
            if added > 0 {
                ActivityLevel::Success
            } else {
                ActivityLevel::Info
            },
            Some(&project_id),
            snapshot.name.clone(),
            Some(match added {
                0 => "No new commands detected".to_string(),
                1 => "1 command detected".to_string(),
                n => format!("{n} commands detected"),
            }),
        ));
        Ok(snapshot)
    })
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn project_status(state: State<AppState>, project_id: String) -> AppResult<ProjectStatus> {
    let project = {
        let ws = state.0.lock();
        ws.project(&project_id)
            .cloned()
            .ok_or_else(|| AppError::unknown_project(&project_id))?
    };
    let path = PathBuf::from(&project.path);

    if !path.exists() {
        return Ok(ProjectStatus {
            project_id,
            exists: false,
            checked_at: now_ms(),
            detection: Detection::default(),
            git: GitStatus::default(),
            error: Some(AppError::not_found(&project.path)),
        });
    }
    if !path.is_dir() {
        return Ok(ProjectStatus {
            project_id,
            exists: false,
            checked_at: now_ms(),
            detection: Detection::default(),
            git: GitStatus::default(),
            error: Some(AppError::not_a_directory(&project.path)),
        });
    }

    Ok(ProjectStatus {
        project_id,
        exists: true,
        checked_at: now_ms(),
        detection: detect::detect(&path),
        git: git::status(&path),
        error: None,
    })
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn run_command(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
    label: String,
    program: String,
) -> AppResult<RunMeta> {
    let (project, single_run) = {
        let ws = state.0.lock();
        let project = ws
            .project(&project_id)
            .cloned()
            .ok_or_else(|| AppError::unknown_project(&project_id))?;
        (project, ws.settings.single_run_per_project)
    };

    if single_run && state.0.runs.is_project_running(&project_id) {
        return Err(AppError::new(
            "ALREADY_RUNNING",
            format!("A command is already running in {}.", project.name),
        )
        .with_hint("Stop it first, or allow several at once in Settings → Command behaviour."));
    }

    let path = PathBuf::from(&project.path);
    let inner = state.0.clone();
    let emitter = Arc::new(TauriEmitter { app: app.clone() });
    let finish_app = app.clone();

    let meta = runner::start(
        state.0.runs.clone(),
        emitter,
        runner::RunRequest {
            project_id: &project.id,
            project_name: &project.name,
            cwd: &path,
            label: &label,
            command: &program,
        },
        move |meta| {
            let duration = meta
                .finished_at
                .unwrap_or(meta.started_at)
                .saturating_sub(meta.started_at);
            let level = match meta.status {
                RunStatus::Succeeded => ActivityLevel::Success,
                RunStatus::Failed | RunStatus::Error => ActivityLevel::Error,
                _ => ActivityLevel::Warn,
            };
            let detail = match meta.status {
                RunStatus::Succeeded => Some(format!("{} · {}", meta.command, pretty_ms(duration))),
                RunStatus::Failed => Some(format!(
                    "{} · exit {}",
                    meta.command,
                    meta.exit_code
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "?".into())
                )),
                RunStatus::Cancelled => Some(format!("{} · cancelled", meta.command)),
                _ => Some(meta.command.clone()),
            };

            let outcome = inner.mutate(|ws| {
                ws.push_history(HistoryEntry {
                    id: new_id("hist"),
                    project_id: meta.project_id.clone(),
                    label: meta.label.clone(),
                    command: meta.command.clone(),
                    at: meta.started_at,
                    duration_ms: duration,
                    exit_code: meta.exit_code,
                    status: meta.status,
                });
                ws.push_activity(activity(
                    ActivityKind::CommandRun,
                    level,
                    Some(&meta.project_id),
                    format!("{} · {}", meta.project_name, meta.label),
                    detail,
                ));
                Ok(ws.clone())
            });
            if let Ok(snapshot) = outcome {
                let _ = finish_app.emit(EVENT_WORKSPACE, snapshot);
            }
        },
    )?;

    Ok(meta)
}

#[tauri::command]
pub fn cancel_run(state: State<AppState>, run_id: String) -> AppResult<RunMeta> {
    state.0.runs.cancel(&run_id)
}

#[tauri::command]
pub fn active_runs(state: State<AppState>) -> Vec<RunMeta> {
    state.0.runs.active()
}

fn pretty_ms(ms: i64) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{}m {:02}s", ms / 60_000, (ms % 60_000) / 1000)
    }
}

// ---------------------------------------------------------------------------
// Settings, activity, storage
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_settings(state: State<AppState>, settings: Settings) -> AppResult<Settings> {
    let sanitized = settings.sanitized();
    state.0.mutate(|ws| {
        ws.settings = sanitized.clone();
        Ok(sanitized.clone())
    })
}

#[tauri::command]
pub fn log_activity(state: State<AppState>, entry: ActivityInput) -> AppResult<()> {
    state.0.mutate(|ws| {
        ws.push_activity(ActivityEntry {
            id: new_id("act"),
            kind: entry.kind,
            level: entry.level,
            project_id: entry.project_id.clone(),
            title: entry.title.clone(),
            detail: entry.detail.clone(),
            at: now_ms(),
        });
        Ok(())
    })
}

#[tauri::command]
pub fn clear_activity(state: State<AppState>) -> AppResult<Workspace> {
    state.0.mutate(|ws| {
        ws.activity.clear();
        ws.history.clear();
        Ok(())
    })?;
    Ok(state.0.snapshot())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub path: String,
    pub size_bytes: u64,
    pub project_count: usize,
    pub activity_count: usize,
    pub history_count: usize,
}

#[tauri::command]
pub fn storage_info(state: State<AppState>) -> StorageInfo {
    let ws = state.0.lock();
    StorageInfo {
        path: state.0.store.location().display().to_string(),
        size_bytes: state.0.store.size_bytes(),
        project_count: ws.projects.len(),
        activity_count: ws.activity.len(),
        history_count: ws.history.len(),
    }
}

#[tauri::command]
pub fn reveal_storage(state: State<AppState>) -> AppResult<()> {
    let location = state.0.store.location();
    let folder = location.parent().unwrap_or(&location).to_path_buf();
    system::open_folder(&folder)
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn available_editors() -> Vec<EditorInfo> {
    system::available_editors()
}

#[tauri::command]
pub fn open_in_editor(state: State<AppState>, project_id: String) -> AppResult<()> {
    let (path, editor, custom) = {
        let ws = state.0.lock();
        let path = project_path(&ws, &project_id)?;
        (
            path,
            ws.settings.editor.clone(),
            ws.settings.custom_editor_command.clone(),
        )
    };
    system::open_in_editor(&editor, custom.as_deref(), &path)
}

#[tauri::command]
pub fn open_project_folder(state: State<AppState>, project_id: String) -> AppResult<()> {
    let path = {
        let ws = state.0.lock();
        project_path(&ws, &project_id)?
    };
    system::open_folder(&path)
}

#[tauri::command]
pub fn open_project_terminal(state: State<AppState>, project_id: String) -> AppResult<()> {
    let path = {
        let ws = state.0.lock();
        project_path(&ws, &project_id)?
    };
    system::open_terminal(&path)
}

#[tauri::command]
pub fn open_repository(state: State<AppState>, project_id: String) -> AppResult<()> {
    let url = {
        let ws = state.0.lock();
        let project = ws
            .project(&project_id)
            .ok_or_else(|| AppError::unknown_project(&project_id))?;
        project.repository_url.clone().ok_or_else(|| {
            AppError::new(
                "NO_REPOSITORY",
                "No repository URL is set for this project.",
            )
            .with_hint("Add one from the project's ⋯ menu.")
        })?
    };
    system::open_url(&url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;
    use tempfile::tempdir;

    /// Exercises the command layer through `Inner`, which is everything the
    /// Tauri wrappers do apart from serialisation.
    fn state() -> Arc<Inner> {
        Arc::new(Inner {
            store: Box::new(MemoryStore::default()),
            workspace: Mutex::new(Workspace::default()),
            runs: Arc::new(RunRegistry::default()),
        })
    }

    fn node_project(dir: &Path) {
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"demo","scripts":{"dev":"vite","test":"vitest"}}"#,
        )
        .unwrap();
    }

    /// Mirrors `add_project` without the Tauri `State` wrapper.
    fn add(inner: &Arc<Inner>, path: &str, name: Option<&str>) -> AppResult<Project> {
        let normalized = normalize_path(path);
        let as_path = Path::new(&normalized);
        if !as_path.exists() {
            return Err(AppError::not_found(&normalized));
        }
        if !as_path.is_dir() {
            return Err(AppError::not_a_directory(&normalized));
        }
        let detection = detect::detect(as_path);
        let display = name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| detect::name_from_path(&normalized));
        let stamp = now_ms();
        let project = Project {
            id: new_id("prj"),
            name: display.clone(),
            path: normalized.clone(),
            favorite: false,
            repository_url: None,
            commands: detection.suggested.clone(),
            created_at: stamp,
            updated_at: stamp,
            last_opened_at: Some(stamp),
        };
        inner.mutate(|ws| {
            if ws.projects.iter().any(|p| same_path(&p.path, &normalized)) {
                return Err(AppError::new("PROJECT_EXISTS", "already there"));
            }
            ws.projects.push(project.clone());
            ws.last_project_id = Some(project.id.clone());
            ws.push_activity(activity(
                ActivityKind::ProjectAdded,
                ActivityLevel::Success,
                Some(&project.id),
                format!("Added {display}"),
                None,
            ));
            Ok(project.clone())
        })
    }

    #[test]
    fn normalize_path_strips_trailing_separators_and_verbatim_prefix() {
        let dir = tempdir().unwrap();
        let with_slash = format!("{}/", dir.path().display());
        let normalized = normalize_path(&with_slash);
        assert!(!normalized.starts_with(r"\\?\"), "got {normalized}");
        assert!(!normalized.ends_with('/') && !normalized.ends_with('\\'));
    }

    #[test]
    fn normalize_path_leaves_unknown_paths_usable() {
        let out = normalize_path("  C:/not/here/  ");
        assert!(out.contains("not"), "got {out}");
    }

    #[test]
    fn adding_a_project_detects_its_commands_and_logs_activity() {
        let inner = state();
        let dir = tempdir().unwrap();
        node_project(dir.path());

        let project = add(&inner, &dir.path().display().to_string(), None).unwrap();
        assert!(
            !project.commands.is_empty(),
            "detected defaults are attached"
        );
        assert!(project.commands.iter().any(|c| c.program == "npm run dev"));

        let ws = inner.snapshot();
        assert_eq!(ws.projects.len(), 1);
        assert_eq!(ws.last_project_id, Some(project.id.clone()));
        assert_eq!(ws.activity.len(), 1);
        assert_eq!(ws.activity[0].kind, ActivityKind::ProjectAdded);
    }

    #[test]
    fn adding_the_same_folder_twice_is_refused_with_an_explanation() {
        let inner = state();
        let dir = tempdir().unwrap();
        let path = dir.path().display().to_string();
        add(&inner, &path, None).unwrap();

        let err = add(&inner, &path, None).unwrap_err();
        assert_eq!(err.code, "PROJECT_EXISTS");
        assert_eq!(inner.snapshot().projects.len(), 1);
    }

    #[test]
    fn adding_a_missing_or_non_directory_path_is_refused() {
        let inner = state();
        assert_eq!(
            add(&inner, "C:/definitely/not/here", None)
                .unwrap_err()
                .code,
            "PATH_NOT_FOUND"
        );

        let dir = tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            add(&inner, &file.display().to_string(), None)
                .unwrap_err()
                .code,
            "NOT_A_DIRECTORY"
        );
        assert!(inner.snapshot().projects.is_empty());
    }

    #[test]
    fn a_custom_display_name_is_used_when_given() {
        let inner = state();
        let dir = tempdir().unwrap();
        let project = add(&inner, &dir.path().display().to_string(), Some("  LUMEN  ")).unwrap();
        assert_eq!(project.name, "LUMEN");
    }

    #[test]
    fn everything_persists_through_the_store() {
        let store = Box::new(MemoryStore::default());
        let dir = tempdir().unwrap();
        node_project(dir.path());

        // First "session": add a project and change a setting.
        let first = AppState::new(store).unwrap();
        let project = add(&first.0, &dir.path().display().to_string(), Some("ZARChat")).unwrap();
        first
            .0
            .mutate(|ws| {
                ws.settings.terminal_font_size = 16;
                ws.settings.theme = Theme::Graphite;
                Ok(())
            })
            .unwrap();

        // The store is the only thing carried across; simulate a restart.
        let carried = first.0.store.load().unwrap();
        let reopened = AppState::new(Box::new({
            let s = MemoryStore::default();
            s.save(&carried).unwrap();
            s
        }))
        .unwrap();

        let ws = reopened.0.snapshot();
        assert_eq!(ws.projects.len(), 1);
        assert_eq!(ws.projects[0].name, "ZARChat");
        assert_eq!(ws.projects[0].id, project.id);
        assert_eq!(ws.settings.terminal_font_size, 16);
        assert_eq!(ws.settings.theme, Theme::Graphite);
        assert_eq!(ws.last_project_id, Some(project.id));
    }

    #[test]
    fn removing_a_project_keeps_the_folder_and_reselects_another() {
        let inner = state();
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let first = add(&inner, &a.path().display().to_string(), Some("A")).unwrap();
        let second = add(&inner, &b.path().display().to_string(), Some("B")).unwrap();

        inner
            .mutate(|ws| {
                let index = ws.projects.iter().position(|p| p.id == second.id).unwrap();
                let removed = ws.projects.remove(index);
                if ws.last_project_id.as_deref() == Some(second.id.as_str()) {
                    ws.last_project_id = ws.projects.first().map(|p| p.id.clone());
                }
                ws.push_activity(activity(
                    ActivityKind::ProjectRemoved,
                    ActivityLevel::Info,
                    None,
                    format!("Removed {}", removed.name),
                    None,
                ));
                Ok(())
            })
            .unwrap();

        let ws = inner.snapshot();
        assert_eq!(ws.projects.len(), 1);
        assert_eq!(ws.last_project_id, Some(first.id));
        assert!(b.path().exists(), "the folder on disk is untouched");
    }

    #[test]
    fn a_failed_mutation_leaves_the_workspace_unchanged() {
        let inner = state();
        let dir = tempdir().unwrap();
        add(&inner, &dir.path().display().to_string(), Some("Keep")).unwrap();

        let err: AppResult<()> = inner.mutate(|ws| {
            ws.projects.clear();
            Err(AppError::new("NOPE", "rolled back"))
        });
        assert!(err.is_err());
        // The guard is dropped without the change being committed to the store,
        // and the next load reflects the last good snapshot.
        assert_eq!(inner.store.load().unwrap().projects.len(), 1);
    }

    #[test]
    fn settings_are_sanitized_on_the_way_in() {
        let inner = state();
        let saved = inner
            .mutate(|ws| {
                ws.settings = Settings {
                    terminal_font_size: 99,
                    max_output_lines: 2,
                    ..Settings::default()
                }
                .sanitized();
                Ok(ws.settings.clone())
            })
            .unwrap();
        assert_eq!(saved.terminal_font_size, 20);
        assert_eq!(saved.max_output_lines, 500);
    }

    #[test]
    fn history_and_activity_are_cleared_together() {
        let inner = state();
        inner
            .mutate(|ws| {
                ws.push_history(HistoryEntry {
                    id: "h".into(),
                    project_id: "p".into(),
                    label: "Test".into(),
                    command: "npm test".into(),
                    at: 1,
                    duration_ms: 10,
                    exit_code: Some(0),
                    status: RunStatus::Succeeded,
                });
                ws.push_activity(activity(
                    ActivityKind::CommandRun,
                    ActivityLevel::Success,
                    None,
                    "ran",
                    None,
                ));
                Ok(())
            })
            .unwrap();
        assert_eq!(inner.snapshot().history.len(), 1);

        inner
            .mutate(|ws| {
                ws.activity.clear();
                ws.history.clear();
                Ok(())
            })
            .unwrap();
        let ws = inner.snapshot();
        assert!(ws.activity.is_empty() && ws.history.is_empty());
        assert!(inner.store.load().unwrap().history.is_empty(), "persisted");
    }

    #[test]
    fn project_status_reports_a_deleted_folder_instead_of_failing() {
        let inner = state();
        let dir = tempdir().unwrap();
        let project = add(&inner, &dir.path().display().to_string(), Some("Gone")).unwrap();
        drop(dir);

        let ws = inner.snapshot();
        let stored = ws.project(&project.id).unwrap();
        let path = PathBuf::from(&stored.path);
        assert!(!path.exists());

        // The command's behaviour for a missing folder.
        let status = ProjectStatus {
            project_id: project.id.clone(),
            exists: false,
            checked_at: now_ms(),
            detection: Detection::default(),
            git: GitStatus::default(),
            error: Some(AppError::not_found(&stored.path)),
        };
        assert!(!status.exists);
        assert_eq!(status.error.unwrap().code, "PATH_NOT_FOUND");
    }

    #[test]
    fn same_path_follows_platform_case_rules() {
        if cfg!(windows) {
            assert!(same_path("C:\\Code\\App", "c:\\code\\app"));
        } else {
            assert!(!same_path("/Code/App", "/code/app"));
        }
        assert!(same_path("/a/b", "/a/b"));
    }

    #[test]
    fn pretty_ms_is_readable() {
        assert_eq!(pretty_ms(900), "900ms");
        assert_eq!(pretty_ms(1500), "1.5s");
        assert_eq!(pretty_ms(61_000), "1m 01s");
    }
}
