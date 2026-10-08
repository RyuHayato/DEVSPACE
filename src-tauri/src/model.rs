//! Serializable domain model shared with the UI.
//!
//! Everything here is `camelCase` over the wire so the TypeScript definitions
//! in `src/lib/types.ts` are a direct mirror.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandKind {
    Dev,
    Test,
    Build,
    Lint,
    Install,
    Custom,
}

impl CommandKind {
    /// Rank used to order detected commands: the ones a developer reaches for
    /// most often come first.
    pub fn rank(self) -> u8 {
        match self {
            CommandKind::Dev => 0,
            CommandKind::Test => 1,
            CommandKind::Build => 2,
            CommandKind::Lint => 3,
            CommandKind::Install => 4,
            CommandKind::Custom => 5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandSource {
    Detected,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDef {
    pub id: String,
    pub label: String,
    /// The full command line, run through the platform shell in the project
    /// directory. Always shown to the user before it executes.
    pub program: String,
    pub kind: CommandKind,
    pub source: CommandSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub repository_url: Option<String>,
    #[serde(default)]
    pub commands: Vec<CommandDef>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Last time the user selected this project, used for sidebar ordering.
    #[serde(default)]
    pub last_opened_at: Option<i64>,
}

/// Partial update applied to a project. Absent fields are left untouched;
/// `repositoryUrl: null` is distinct from omitting it and clears the value.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub name: Option<String>,
    pub path: Option<String>,
    pub favorite: Option<bool>,
    #[serde(default, with = "double_option")]
    pub repository_url: Option<Option<String>>,
}

/// Lets us tell `{}` apart from `{"repositoryUrl": null}`.
mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    /// Marker files found at the project root, e.g. `package.json`.
    pub markers: Vec<String>,
    /// Ecosystems inferred from those markers, e.g. `node`, `rust`.
    pub ecosystems: Vec<String>,
    pub primary_language: Option<String>,
    pub package_manager: Option<String>,
    /// Human label such as "Vite · React" or "Cargo workspace".
    pub project_type: Option<String>,
    pub scripts: Vec<ScriptEntry>,
    pub has_git: bool,
    /// Commands we would suggest for a project that has none configured.
    pub suggested: Vec<CommandDef>,
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Conflicted,
    TypeChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    /// Two-letter porcelain code, e.g. `M.`, `.M`, `??`.
    pub code: String,
    pub kind: ChangeKind,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub available: bool,
    pub branch: Option<String>,
    pub head_short: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub clean: bool,
    pub files: Vec<GitFile>,
    /// True when `files` was capped for display.
    pub truncated: bool,
    pub total_changed: u32,
}

// ---------------------------------------------------------------------------
// Combined status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub project_id: String,
    pub exists: bool,
    pub checked_at: i64,
    pub detection: Detection,
    pub git: GitStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::error::AppError>,
}

// ---------------------------------------------------------------------------
// Command runs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Error,
}

/// Live state of a command run. Flows UI-ward only, so it is serialise-only;
/// the persisted record of a finished run is `HistoryEntry`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMeta {
    pub run_id: String,
    pub project_id: String,
    pub project_name: String,
    pub label: String,
    pub command: String,
    pub cwd: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub status: RunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::error::AppError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
    /// DevWorkspace's own notes, e.g. "process cancelled".
    System,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLine {
    pub seq: u64,
    pub stream: OutputStream,
    pub text: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputBatch {
    pub run_id: String,
    pub lines: Vec<OutputLine>,
}

/// Persisted summary of a finished run, used for history and re-running.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub command: String,
    pub at: i64,
    pub duration_ms: i64,
    pub exit_code: Option<i32>,
    pub status: RunStatus,
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    CommandRun,
    ProjectAdded,
    ProjectRemoved,
    ProjectUpdated,
    ProjectOpened,
    StatusChanged,
    ActionRun,
    Problem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityLevel {
    Info,
    Success,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub kind: ActivityKind,
    pub level: ActivityLevel,
    pub project_id: Option<String>,
    pub title: String,
    pub detail: Option<String>,
    pub at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityInput {
    pub kind: ActivityKind,
    #[serde(default = "default_level")]
    pub level: ActivityLevel,
    pub project_id: Option<String>,
    pub title: String,
    pub detail: Option<String>,
}

fn default_level() -> ActivityLevel {
    ActivityLevel::Info
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Cool near-black.
    Midnight,
    /// Warmer, slightly lifted charcoal.
    Graphite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Accent {
    Ember,
    Sage,
    Steel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Comfortable,
    Compact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotionPref {
    System,
    Reduced,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    pub accent: Accent,
    pub density: Density,
    pub motion: MotionPref,
    pub terminal_font_size: u8,
    /// Identifier of the preferred editor, e.g. `code`, or `custom`.
    pub editor: String,
    pub custom_editor_command: Option<String>,
    pub confirm_before_run: bool,
    pub single_run_per_project: bool,
    pub auto_scroll_output: bool,
    pub show_timestamps: bool,
    pub max_output_lines: u32,
    /// Seconds between background status refreshes; 0 disables them.
    pub status_refresh_seconds: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::Midnight,
            accent: Accent::Ember,
            density: Density::Comfortable,
            motion: MotionPref::System,
            terminal_font_size: 12,
            editor: "code".into(),
            custom_editor_command: None,
            confirm_before_run: false,
            single_run_per_project: true,
            auto_scroll_output: true,
            show_timestamps: false,
            max_output_lines: 5000,
            status_refresh_seconds: 30,
        }
    }
}

impl Settings {
    /// Clamps values that would otherwise break the UI if hand-edited in the
    /// JSON file.
    pub fn sanitized(mut self) -> Self {
        self.terminal_font_size = self.terminal_font_size.clamp(10, 20);
        self.max_output_lines = self.max_output_lines.clamp(500, 100_000);
        if self.status_refresh_seconds != 0 {
            self.status_refresh_seconds = self.status_refresh_seconds.clamp(5, 3600);
        }
        if self.editor.trim().is_empty() {
            self.editor = "code".into();
        }
        if let Some(cmd) = &self.custom_editor_command {
            if cmd.trim().is_empty() {
                self.custom_editor_command = None;
            }
        }
        self
    }
}

// ---------------------------------------------------------------------------
// Workspace (the persisted document)
// ---------------------------------------------------------------------------

pub const WORKSPACE_VERSION: u32 = 1;
pub const MAX_ACTIVITY: usize = 250;
pub const MAX_HISTORY: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub version: u32,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub activity: Vec<ActivityEntry>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    #[serde(default)]
    pub last_project_id: Option<String>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: WORKSPACE_VERSION,
            projects: Vec::new(),
            settings: Settings::default(),
            activity: Vec::new(),
            history: Vec::new(),
            last_project_id: None,
        }
    }
}

impl Workspace {
    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    pub fn project_mut(&mut self, id: &str) -> Option<&mut Project> {
        self.projects.iter_mut().find(|p| p.id == id)
    }

    /// Newest first, capped.
    pub fn push_activity(&mut self, entry: ActivityEntry) {
        self.activity.insert(0, entry);
        self.activity.truncate(MAX_ACTIVITY);
    }

    pub fn push_history(&mut self, entry: HistoryEntry) {
        self.history.insert(0, entry);
        self.history.truncate(MAX_HISTORY);
    }

    /// Repairs a document that may have been hand-edited or written by an
    /// older build, so a single bad field can never brick the app.
    pub fn sanitized(mut self) -> Self {
        self.version = WORKSPACE_VERSION;
        self.settings = self.settings.sanitized();
        self.projects
            .retain(|p| !p.id.is_empty() && !p.path.is_empty());

        // Drop duplicate project ids, keeping the first.
        let mut seen = std::collections::HashSet::new();
        self.projects.retain(|p| seen.insert(p.id.clone()));

        for project in &mut self.projects {
            if project.name.trim().is_empty() {
                project.name = crate::detect::name_from_path(&project.path);
            }
            project.commands.retain(|c| !c.program.trim().is_empty());
            let mut cmd_ids = std::collections::HashSet::new();
            project.commands.retain(|c| cmd_ids.insert(c.id.clone()));
        }

        self.activity.truncate(MAX_ACTIVITY);
        self.history.truncate(MAX_HISTORY);

        if let Some(last) = &self.last_project_id {
            if !self.projects.iter().any(|p| &p.id == last) {
                self.last_project_id = None;
            }
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_clamp_out_of_range_values() {
        let s = Settings {
            terminal_font_size: 99,
            max_output_lines: 1,
            status_refresh_seconds: 1,
            editor: "  ".into(),
            custom_editor_command: Some("   ".into()),
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(s.terminal_font_size, 20);
        assert_eq!(s.max_output_lines, 500);
        assert_eq!(s.status_refresh_seconds, 5);
        assert_eq!(s.editor, "code");
        assert_eq!(s.custom_editor_command, None);
    }

    #[test]
    fn zero_refresh_means_manual_and_is_preserved() {
        let s = Settings {
            status_refresh_seconds: 0,
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(s.status_refresh_seconds, 0);
    }

    #[test]
    fn sanitize_drops_duplicate_and_empty_projects() {
        let make = |id: &str, path: &str| Project {
            id: id.into(),
            name: "n".into(),
            path: path.into(),
            favorite: false,
            repository_url: None,
            commands: vec![],
            created_at: 0,
            updated_at: 0,
            last_opened_at: None,
        };
        let ws = Workspace {
            projects: vec![
                make("a", "/a"),
                make("a", "/dup"),
                make("", "/b"),
                make("c", ""),
            ],
            last_project_id: Some("gone".into()),
            ..Workspace::default()
        }
        .sanitized();
        assert_eq!(ws.projects.len(), 1);
        assert_eq!(ws.projects[0].path, "/a");
        assert_eq!(ws.last_project_id, None);
    }

    #[test]
    fn activity_is_capped_newest_first() {
        let mut ws = Workspace::default();
        for i in 0..(MAX_ACTIVITY + 10) {
            ws.push_activity(ActivityEntry {
                id: format!("{i}"),
                kind: ActivityKind::ProjectOpened,
                level: ActivityLevel::Info,
                project_id: None,
                title: format!("{i}"),
                detail: None,
                at: i as i64,
            });
        }
        assert_eq!(ws.activity.len(), MAX_ACTIVITY);
        assert_eq!(ws.activity[0].title, (MAX_ACTIVITY + 9).to_string());
    }

    #[test]
    fn patch_distinguishes_absent_from_null_repository_url() {
        let absent: ProjectPatch = serde_json::from_str("{}").unwrap();
        assert_eq!(absent.repository_url, None);
        let cleared: ProjectPatch = serde_json::from_str(r#"{"repositoryUrl":null}"#).unwrap();
        assert_eq!(cleared.repository_url, Some(None));
        let set: ProjectPatch = serde_json::from_str(r#"{"repositoryUrl":"https://x"}"#).unwrap();
        assert_eq!(set.repository_url, Some(Some("https://x".into())));
    }

    #[test]
    fn workspace_roundtrips_as_camel_case() {
        let ws = Workspace::default();
        let json = serde_json::to_string(&ws).unwrap();
        assert!(json.contains("\"lastProjectId\""));
        assert!(json.contains("\"terminalFontSize\""));
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.settings, ws.settings);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let ws: Workspace = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert!(ws.projects.is_empty());
        assert_eq!(ws.settings, Settings::default());
    }
}
