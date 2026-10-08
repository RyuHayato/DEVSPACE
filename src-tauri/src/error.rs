//! Typed, user-facing error surface.
//!
//! Every error that can reach the UI carries a stable `code`, a short human
//! message, and (where we can infer one) an actionable `hint`. Internal
//! details such as backtraces or raw OS error text are deliberately reduced to
//! a single sentence so the UI never has to render a stack trace.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn not_found(path: &str) -> Self {
        Self::new("PATH_NOT_FOUND", format!("`{path}` no longer exists."))
            .with_hint("The folder may have been moved, renamed or deleted. Update the project path or remove it from DevWorkspace.")
    }

    pub fn not_a_directory(path: &str) -> Self {
        Self::new("NOT_A_DIRECTORY", format!("`{path}` is not a folder."))
            .with_hint("Pick the project's root folder rather than a file inside it.")
    }

    pub fn permission(path: &str) -> Self {
        Self::new(
            "PERMISSION_DENIED",
            format!("Access to `{path}` was denied."),
        )
        .with_hint(
            "Check the folder's permissions, or run DevWorkspace as a user that can read it.",
        )
    }

    pub fn unknown_project(id: &str) -> Self {
        Self::new("PROJECT_NOT_FOUND", format!("Unknown project `{id}`."))
            .with_hint("It may have been removed in another window. Reload DevWorkspace.")
    }

    pub fn unknown_run(id: &str) -> Self {
        Self::new("RUN_NOT_FOUND", format!("Unknown command run `{id}`."))
            .with_hint("The command has already finished.")
    }

    pub fn empty_command() -> Self {
        Self::new("EMPTY_COMMAND", "That command is empty.").with_hint(
            "Enter the command exactly as you would type it in a terminal, for example `npm test`.",
        )
    }

    /// Classifies a filesystem error into something we can explain.
    pub fn from_io(path: &str, err: &std::io::Error) -> Self {
        use std::io::ErrorKind;
        match err.kind() {
            ErrorKind::NotFound => Self::not_found(path),
            ErrorKind::PermissionDenied => Self::permission(path),
            _ => Self::new("IO_ERROR", format!("Could not read `{path}`."))
                .with_hint(short_os_reason(err)),
        }
    }

    pub fn storage(err: &std::io::Error) -> Self {
        Self::new(
            "STORAGE_ERROR",
            "DevWorkspace could not write its local data file.",
        )
        .with_hint(short_os_reason(err))
    }
}

/// Reduces an OS error to one short sentence, without codes or backtraces.
pub fn short_os_reason(err: &std::io::Error) -> String {
    let raw = err.to_string();
    let first = raw
        .split(" (os error")
        .next()
        .unwrap_or(&raw)
        .trim()
        .trim_end_matches('.')
        .to_string();
    if first.is_empty() {
        "The operating system did not say why.".to_string()
    } else {
        let mut chars = first.chars();
        let capitalised = match chars.next() {
            Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
            None => first,
        };
        format!("{capitalised}.")
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn io_not_found_becomes_path_not_found() {
        let err = Error::new(ErrorKind::NotFound, "nope");
        let app = AppError::from_io("C:/missing", &err);
        assert_eq!(app.code, "PATH_NOT_FOUND");
        assert!(app.hint.is_some());
    }

    #[test]
    fn io_permission_denied_is_classified() {
        let err = Error::new(ErrorKind::PermissionDenied, "nope");
        assert_eq!(AppError::from_io("C:/x", &err).code, "PERMISSION_DENIED");
    }

    #[test]
    fn os_reason_strips_error_codes_and_punctuation() {
        let err = Error::from_raw_os_error(2);
        let reason = short_os_reason(&err);
        assert!(!reason.contains("os error"), "got {reason}");
        assert!(reason.ends_with('.'));
        assert!(reason.starts_with(|c: char| c.is_uppercase()));
    }

    #[test]
    fn errors_never_leak_a_debug_payload_into_the_message() {
        let err = Error::other("thread 'main' panicked at src/x.rs:1:1");
        let app = AppError::from_io("C:/x", &err);
        assert!(!app.message.contains("panicked"));
    }
}
