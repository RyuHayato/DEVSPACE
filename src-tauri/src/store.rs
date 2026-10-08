//! Local persistence.
//!
//! The whole workspace lives in a single JSON document. Writes are atomic
//! (write to a sibling temp file, then rename) so a crash or a power cut can
//! never leave a half-written file behind. `Persistence` is a trait so the
//! backing store can be swapped later without touching the command layer.

use crate::error::{AppError, AppResult};
use crate::model::Workspace;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub trait Persistence: Send + Sync {
    fn load(&self) -> AppResult<Workspace>;
    fn save(&self, workspace: &Workspace) -> AppResult<()>;
    /// Where the data lives, for the Settings screen.
    fn location(&self) -> PathBuf;
    fn size_bytes(&self) -> u64;
}

pub struct JsonFileStore {
    path: PathBuf,
}

impl JsonFileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Moves a document we could not parse aside instead of destroying it, so
    /// the user can recover anything they care about.
    fn quarantine(&self) {
        let backup = self.path.with_extension("corrupt.json");
        let _ = fs::rename(&self.path, backup);
    }
}

impl Persistence for JsonFileStore {
    fn load(&self) -> AppResult<Workspace> {
        match fs::read_to_string(&self.path) {
            Ok(raw) => match serde_json::from_str::<Workspace>(&raw) {
                Ok(ws) => Ok(ws.sanitized()),
                Err(_) => {
                    self.quarantine();
                    Ok(Workspace::default())
                }
            },
            // A missing file is the normal first-run case.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Workspace::default()),
            Err(e) => Err(AppError::from_io(&self.path.display().to_string(), &e)),
        }
    }

    fn save(&self, workspace: &Workspace) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::storage(&e))?;
        }
        let json = serde_json::to_string_pretty(workspace).map_err(|_| {
            AppError::new("SERIALIZE_ERROR", "DevWorkspace could not encode its data.")
        })?;

        let tmp = self.path.with_extension("tmp");
        {
            let mut file = fs::File::create(&tmp).map_err(|e| AppError::storage(&e))?;
            file.write_all(json.as_bytes())
                .map_err(|e| AppError::storage(&e))?;
            file.sync_all().map_err(|e| AppError::storage(&e))?;
        }
        // Windows `rename` fails if the destination exists, so replace it.
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(|e| AppError::storage(&e))?;
        }
        fs::rename(&tmp, &self.path).map_err(|e| AppError::storage(&e))?;
        Ok(())
    }

    fn location(&self) -> PathBuf {
        self.path.clone()
    }

    fn size_bytes(&self) -> u64 {
        fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }
}

/// In-memory store used by tests.
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<Option<Workspace>>,
}

impl Persistence for MemoryStore {
    fn load(&self) -> AppResult<Workspace> {
        Ok(self
            .inner
            .lock()
            .expect("memory store poisoned")
            .clone()
            .unwrap_or_default())
    }

    fn save(&self, workspace: &Workspace) -> AppResult<()> {
        *self.inner.lock().expect("memory store poisoned") = Some(workspace.clone());
        Ok(())
    }

    fn location(&self) -> PathBuf {
        PathBuf::from("(memory)")
    }

    fn size_bytes(&self) -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Project, Settings, Theme};
    use tempfile::tempdir;

    fn project(name: &str) -> Project {
        Project {
            id: crate::model::new_id("prj"),
            name: name.into(),
            path: "/tmp/x".into(),
            favorite: false,
            repository_url: None,
            commands: vec![],
            created_at: 1,
            updated_at: 1,
            last_opened_at: None,
        }
    }

    #[test]
    fn first_run_returns_an_empty_workspace() {
        let dir = tempdir().unwrap();
        let store = JsonFileStore::new(dir.path().join("workspace.json"));
        let ws = store.load().unwrap();
        assert!(ws.projects.is_empty());
    }

    #[test]
    fn projects_and_settings_survive_a_save_load_cycle() {
        let dir = tempdir().unwrap();
        let store = JsonFileStore::new(dir.path().join("nested").join("workspace.json"));

        let mut ws = Workspace::default();
        ws.projects.push(project("ZARChat"));
        ws.settings = Settings {
            theme: Theme::Graphite,
            terminal_font_size: 15,
            ..Settings::default()
        };
        ws.last_project_id = Some(ws.projects[0].id.clone());
        store.save(&ws).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.projects[0].name, "ZARChat");
        assert_eq!(loaded.settings.theme, Theme::Graphite);
        assert_eq!(loaded.settings.terminal_font_size, 15);
        assert_eq!(loaded.last_project_id, Some(ws.projects[0].id.clone()));
    }

    #[test]
    fn saving_twice_overwrites_rather_than_failing() {
        let dir = tempdir().unwrap();
        let store = JsonFileStore::new(dir.path().join("workspace.json"));
        let mut ws = Workspace::default();
        store.save(&ws).unwrap();
        ws.projects.push(project("second"));
        store.save(&ws).unwrap();
        assert_eq!(store.load().unwrap().projects.len(), 1);
    }

    #[test]
    fn no_temp_file_is_left_behind() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = JsonFileStore::new(&path);
        store.save(&Workspace::default()).unwrap();
        assert!(!path.with_extension("tmp").exists());
    }

    #[test]
    fn a_corrupt_document_is_quarantined_not_lost() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        fs::write(&path, "{ this is not json").unwrap();
        let store = JsonFileStore::new(&path);

        let ws = store.load().unwrap();
        assert!(ws.projects.is_empty(), "falls back to a usable workspace");
        assert!(
            path.with_extension("corrupt.json").exists(),
            "original kept for recovery"
        );
    }

    #[test]
    fn loading_repairs_a_hand_edited_document() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        fs::write(
            &path,
            r#"{"version":1,"settings":{"theme":"midnight","accent":"ember","density":"comfortable",
                "motion":"system","terminalFontSize":200,"editor":"code","customEditorCommand":null,
                "confirmBeforeRun":false,"singleRunPerProject":true,"autoScrollOutput":true,
                "showTimestamps":false,"maxOutputLines":5,"statusRefreshSeconds":1}}"#,
        )
        .unwrap();
        let ws = JsonFileStore::new(&path).load().unwrap();
        assert_eq!(ws.settings.terminal_font_size, 20);
        assert_eq!(ws.settings.max_output_lines, 500);
    }

    #[test]
    fn size_and_location_are_reported() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let store = JsonFileStore::new(&path);
        assert_eq!(store.size_bytes(), 0);
        store.save(&Workspace::default()).unwrap();
        assert!(store.size_bytes() > 0);
        assert_eq!(store.location(), path);
    }

    #[test]
    fn memory_store_satisfies_the_same_contract() {
        let store = MemoryStore::default();
        assert!(store.load().unwrap().projects.is_empty());
        let mut ws = Workspace::default();
        ws.projects.push(project("x"));
        store.save(&ws).unwrap();
        assert_eq!(store.load().unwrap().projects.len(), 1);
    }
}
