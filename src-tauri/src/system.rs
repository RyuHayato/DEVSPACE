//! Platform integration: launching processes, editors, folders and URLs.
//!
//! Two rules shape this module:
//!
//! 1. Nothing is ever handed to a shell for *re-parsing* unless the user typed
//!    it as a command. Paths and URLs are passed as real arguments, or wrapped
//!    with `cmd /S /C "…"` so quoted arguments survive verbatim.
//! 2. We probe for executables before offering an action, so the UI only shows
//!    things that can actually happen on this machine.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// A `Command` that never flashes a console window on Windows. Used for every
/// process we read output from.
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Builds the command that runs a user-authored command line inside `cwd`.
///
/// The command line is shown to the user in the UI before this is called;
/// it is passed to the platform shell exactly as typed so that pipes,
/// `&&` and quoting behave the way they would in a terminal.
pub fn shell_command(command_line: &str, cwd: &Path) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = hidden_command("cmd.exe");
        cmd.arg("/S").arg("/C");
        // `/S` with surrounding quotes makes cmd strip only the outer pair,
        // leaving any inner quoting from the user's command line intact.
        cmd.raw_arg(format!("\"{command_line}\""));
        cmd.current_dir(cwd);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(command_line).current_dir(cwd);
        cmd
    }
}

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

/// Resolves a bare command name against `PATH`, honouring `PATHEXT` on
/// Windows so `code` finds `code.cmd`.
pub fn resolve_executable(name: &str) -> Option<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }

    // An explicit path is used as-is.
    if name.contains('/') || name.contains('\\') {
        let direct = PathBuf::from(name);
        return direct.is_file().then_some(direct);
    }

    let paths = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };

    for dir in std::env::split_paths(&paths) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in &extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// True when a resolved Windows executable is a batch launcher, which
/// `CreateProcess` cannot run directly.
fn needs_shell(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(OsStr::to_str)
            .map(str::to_lowercase)
            .as_deref(),
        Some("cmd") | Some("bat")
    )
}

/// Spawns `exe arg`, routing through `cmd /S /C` when `exe` is a batch file.
/// `arg` is always a single argument, never re-parsed as a command.
fn spawn_with_argument(exe: &Path, arg: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if needs_shell(exe) {
            use std::os::windows::process::CommandExt;
            let mut cmd = hidden_command("cmd.exe");
            cmd.arg("/S").arg("/C");
            cmd.raw_arg(format!("\"\"{}\" \"{}\"\"", exe.display(), arg));
            cmd.spawn()?;
            return Ok(());
        }
    }
    hidden_command(exe).arg(arg).spawn()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub id: String,
    pub label: String,
    pub command: String,
    pub available: bool,
}

/// Editors we know how to launch, in the order they are offered.
const KNOWN_EDITORS: &[(&str, &str)] = &[
    ("code", "Visual Studio Code"),
    ("code-insiders", "VS Code Insiders"),
    ("cursor", "Cursor"),
    ("windsurf", "Windsurf"),
    ("zed", "Zed"),
    ("subl", "Sublime Text"),
    ("idea", "IntelliJ IDEA"),
    ("webstorm", "WebStorm"),
];

/// Probes the machine once per call. The UI caches the result and only shows
/// "Open in …" for editors that are actually installed.
pub fn available_editors() -> Vec<EditorInfo> {
    KNOWN_EDITORS
        .iter()
        .map(|(id, label)| EditorInfo {
            id: (*id).to_string(),
            label: (*label).to_string(),
            command: (*id).to_string(),
            available: resolve_executable(id).is_some(),
        })
        .collect()
}

/// Opens `path` in the configured editor.
pub fn open_in_editor(editor: &str, custom_command: Option<&str>, path: &Path) -> AppResult<()> {
    let program = if editor == "custom" {
        custom_command
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| {
                AppError::new("EDITOR_NOT_CONFIGURED", "No custom editor command is set.")
                    .with_hint("Add the command for your editor in Settings → Default editor.")
            })?
    } else {
        editor
    };

    let label = KNOWN_EDITORS
        .iter()
        .find(|(id, _)| *id == program)
        .map(|(_, label)| *label)
        .unwrap_or(program);

    let exe = resolve_executable(program).ok_or_else(|| {
        AppError::new(
            "EDITOR_NOT_FOUND",
            format!("`{program}` is not on your PATH."),
        )
        .with_hint(format!(
            "DevWorkspace could not find {label}. Install it, or pick a different editor in Settings."
        ))
    })?;

    spawn_with_argument(&exe, &path.display().to_string()).map_err(|e| {
        AppError::new("EDITOR_LAUNCH_FAILED", format!("{label} did not start."))
            .with_hint(crate::error::short_os_reason(&e))
    })
}

// ---------------------------------------------------------------------------
// Folders, terminals, URLs
// ---------------------------------------------------------------------------

/// Reveals a folder in the system file manager.
pub fn open_folder(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::not_found(&path.display().to_string()));
    }
    let display = path.display().to_string();

    #[cfg(windows)]
    let result = {
        // `explorer` takes the path as one argument, so no shell is involved.
        // It also exits with a non-zero code on success, hence `spawn`.
        hidden_command("explorer.exe")
            .arg(&display)
            .spawn()
            .map(|_| ())
    };
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&display).spawn().map(|_| ());
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&display).spawn().map(|_| ());

    result.map_err(|e| {
        AppError::new("OPEN_FOLDER_FAILED", "Could not open the file manager.")
            .with_hint(crate::error::short_os_reason(&e))
    })
}

/// Opens an interactive terminal in the project directory.
pub fn open_terminal(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::not_found(&path.display().to_string()));
    }

    #[cfg(windows)]
    {
        // Prefer Windows Terminal, which takes the directory as an argument.
        if let Some(wt) = resolve_executable("wt.exe").or_else(|| resolve_executable("wt")) {
            if hidden_command(&wt)
                .arg("-d")
                .arg(path.display().to_string())
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        // Otherwise open a plain console in the directory. Setting the working
        // directory avoids having to build a `cd` command line at all.
        use std::os::windows::process::CommandExt;
        Command::new("cmd.exe")
            .arg("/K")
            .current_dir(path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| {
                AppError::new("OPEN_TERMINAL_FAILED", "Could not open a terminal.")
                    .with_hint(crate::error::short_os_reason(&e))
            })
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(path.display().to_string())
            .spawn()
            .map(|_| ())
            .map_err(|e| {
                AppError::new("OPEN_TERMINAL_FAILED", "Could not open Terminal.")
                    .with_hint(crate::error::short_os_reason(&e))
            })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        const TERMINALS: &[&str] = &[
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "alacritty",
            "kitty",
            "wezterm",
            "xterm",
        ];
        for candidate in TERMINALS {
            if resolve_executable(candidate).is_some()
                && Command::new(candidate).current_dir(path).spawn().is_ok()
            {
                return Ok(());
            }
        }
        Err(
            AppError::new("OPEN_TERMINAL_FAILED", "No terminal emulator was found.")
                .with_hint("Install one of gnome-terminal, konsole, alacritty, kitty or xterm."),
        )
    }
}

/// Validates a repository URL. Only `http`/`https` are allowed, which keeps
/// `file:`, `javascript:` and shell-ish values out of the launcher entirely.
pub fn validate_url(url: &str) -> AppResult<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("EMPTY_URL", "No repository URL is set.")
            .with_hint("Add the project's repository URL in its settings."));
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(AppError::new(
            "UNSUPPORTED_URL",
            "Only http and https links can be opened.",
        )
        .with_hint("Use the full web address, for example https://github.com/you/project."));
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || c == '"' || c == '\'')
    {
        return Err(
            AppError::new("INVALID_URL", "That URL contains invalid characters.")
                .with_hint("Copy the address straight from your browser's address bar."),
        );
    }
    // A bare scheme with no host is a typo, not a link.
    let host = lower
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    if host.is_empty() || host.starts_with('/') {
        return Err(AppError::new("INVALID_URL", "That URL has no address.")
            .with_hint("Use the full web address, for example https://github.com/you/project."));
    }
    Ok(trimmed.to_string())
}

/// Opens a validated web URL in the default browser.
pub fn open_url(url: &str) -> AppResult<()> {
    let url = validate_url(url)?;

    #[cfg(windows)]
    let result = hidden_command("explorer.exe").arg(&url).spawn().map(|_| ());
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).spawn().map(|_| ());
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&url).spawn().map(|_| ());

    result.map_err(|e| {
        AppError::new("OPEN_URL_FAILED", "Could not open your browser.")
            .with_hint(crate::error::short_os_reason(&e))
    })
}

/// Terminates a process tree by id. Used to cancel a running command.
///
/// Killing only the direct child would orphan the real work, because the
/// child is the platform shell; both branches target the whole tree.
pub fn kill_process_tree(pid: u32) -> bool {
    #[cfg(windows)]
    {
        hidden_command("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        // The child is its own process group leader (see `runner`), so a
        // negative pid signals the whole group.
        let group = format!("-{pid}");
        let term = Command::new("kill")
            .args(["-TERM", &group])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if term {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let _ = Command::new("kill").args(["-KILL", &group]).output();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_and_https_urls_are_accepted() {
        assert!(validate_url("https://github.com/you/project").is_ok());
        assert!(validate_url("http://localhost:3000/path?a=1&b=2").is_ok());
        assert_eq!(
            validate_url("  https://example.com  ").unwrap(),
            "https://example.com",
            "surrounding whitespace is trimmed"
        );
    }

    #[test]
    fn dangerous_schemes_are_rejected() {
        for url in [
            "file:///C:/Windows/System32",
            "javascript:alert(1)",
            "ftp://example.com",
            "ssh://git@github.com/x.git",
            "git@github.com:you/project.git",
            "C:\\Windows\\System32\\calc.exe",
        ] {
            let err = validate_url(url).expect_err(url);
            assert_eq!(err.code, "UNSUPPORTED_URL", "{url}");
            assert!(err.hint.is_some());
        }
    }

    #[test]
    fn quotes_and_control_characters_are_rejected() {
        assert_eq!(
            validate_url("https://example.com/\"evil").unwrap_err().code,
            "INVALID_URL"
        );
        assert_eq!(
            validate_url("https://example.com/\nmore").unwrap_err().code,
            "INVALID_URL"
        );
    }

    #[test]
    fn an_empty_or_hostless_url_is_rejected_with_a_hint() {
        assert_eq!(validate_url("   ").unwrap_err().code, "EMPTY_URL");
        assert_eq!(validate_url("https://").unwrap_err().code, "INVALID_URL");
        assert_eq!(
            validate_url("https:///path").unwrap_err().code,
            "INVALID_URL"
        );
    }

    #[test]
    fn resolve_executable_finds_a_known_system_binary() {
        // Every supported platform ships one of these.
        let found = resolve_executable("cmd.exe").is_some()
            || resolve_executable("sh").is_some()
            || resolve_executable("ls").is_some();
        assert!(found, "expected to resolve at least one system binary");
    }

    #[test]
    fn resolve_executable_rejects_nonsense_and_empty_names() {
        assert!(resolve_executable("definitely-not-a-real-binary-xyz").is_none());
        assert!(resolve_executable("").is_none());
        assert!(resolve_executable("   ").is_none());
    }

    #[test]
    fn batch_launchers_are_detected_as_needing_a_shell() {
        assert!(needs_shell(Path::new("C:/tools/code.cmd")));
        assert!(needs_shell(Path::new("C:/tools/thing.BAT")));
        assert!(!needs_shell(Path::new("C:/tools/code.exe")));
        assert!(!needs_shell(Path::new("/usr/bin/code")));
    }

    #[test]
    fn editor_probe_returns_the_full_catalogue_with_availability() {
        let editors = available_editors();
        assert_eq!(editors.len(), KNOWN_EDITORS.len());
        assert!(editors.iter().any(|e| e.id == "code"));
        // Every entry is answerable, whether or not it is installed here.
        assert!(editors.iter().all(|e| !e.label.is_empty()));
    }

    #[test]
    fn a_custom_editor_without_a_command_explains_itself() {
        let err = open_in_editor("custom", None, Path::new(".")).unwrap_err();
        assert_eq!(err.code, "EDITOR_NOT_CONFIGURED");
        assert!(err.hint.unwrap().contains("Settings"));
    }

    #[test]
    fn a_missing_editor_explains_itself_rather_than_failing_silently() {
        let err = open_in_editor("definitely-not-an-editor-xyz", None, Path::new(".")).unwrap_err();
        assert_eq!(err.code, "EDITOR_NOT_FOUND");
        assert!(err.hint.is_some());
    }

    #[test]
    fn opening_a_missing_folder_reports_path_not_found() {
        let err = open_folder(Path::new("C:/definitely/not/here")).unwrap_err();
        assert_eq!(err.code, "PATH_NOT_FOUND");
    }

    #[test]
    fn shell_command_runs_in_the_requested_directory() {
        let dir = tempfile::tempdir().unwrap();
        let out = shell_command("echo devworkspace", dir.path())
            .output()
            .expect("the platform shell should be available");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("devworkspace"));
    }

    #[test]
    fn shell_command_preserves_inner_quoting() {
        let dir = tempfile::tempdir().unwrap();
        let out = shell_command("echo \"two words\"", dir.path())
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("two words"), "got {text:?}");
    }

    #[test]
    fn killing_an_unused_pid_does_not_panic() {
        // A pid that cannot exist; the call must simply report failure.
        let _ = kill_process_tree(u32::MAX);
    }
}
