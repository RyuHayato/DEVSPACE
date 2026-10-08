//! Focused Git status reading.
//!
//! This is deliberately *not* a Git client. It answers the questions the
//! overview asks — which branch, is it clean, what changed — by parsing
//! `git status --porcelain=v2 --branch`. The parser is a pure function so the
//! format handling is fully testable without a repository on disk.

use crate::model::{ChangeKind, GitFile, GitStatus};
use std::path::Path;

/// How many changed files we hand to the UI. The counts stay exact.
const MAX_FILES: usize = 300;

/// Runs `git status` in `root`. Never returns an error: an unavailable `git`
/// or a non-repository is a legitimate state the UI renders differently.
pub fn status(root: &Path) -> GitStatus {
    let output = crate::system::hidden_command("git")
        .args([
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ])
        .current_dir(root)
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut parsed = parse_porcelain_v2(&text);
            parsed.available = true;
            parsed.is_repo = true;
            parsed
        }
        Ok(_) => GitStatus {
            available: true,
            is_repo: false,
            clean: true,
            ..GitStatus::default()
        },
        // `git` is not installed or not on PATH.
        Err(_) => GitStatus {
            available: false,
            is_repo: false,
            clean: true,
            ..GitStatus::default()
        },
    }
}

/// Parses the v2 porcelain format. See `git status --help`, "Porcelain
/// Format Version 2".
pub fn parse_porcelain_v2(text: &str) -> GitStatus {
    let mut out = GitStatus {
        clean: true,
        ..GitStatus::default()
    };
    let mut files: Vec<GitFile> = Vec::new();

    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        match line.as_bytes()[0] {
            b'#' => parse_header(line, &mut out),
            b'1' => {
                // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                if let Some(entry) = ordinary_entry(line) {
                    files.push(entry);
                }
            }
            b'2' => {
                // 2 <XY> ... <Xscore> <path><TAB><origPath>
                if let Some(entry) = renamed_entry(line) {
                    files.push(entry);
                }
            }
            b'u' => {
                // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
                if let Some(path) = nth_field(line, 11) {
                    let code = field(line, 1).unwrap_or("UU").to_string();
                    files.push(GitFile {
                        path: clean_path(path),
                        code,
                        kind: ChangeKind::Conflicted,
                        staged: false,
                        unstaged: true,
                    });
                }
            }
            b'?' => {
                if let Some(path) = nth_field(line, 2) {
                    files.push(GitFile {
                        path: clean_path(path),
                        code: "??".into(),
                        kind: ChangeKind::Untracked,
                        staged: false,
                        unstaged: true,
                    });
                }
            }
            // '!' is an ignored file; we never ask for those.
            _ => {}
        }
    }

    for file in &files {
        match file.kind {
            ChangeKind::Conflicted => out.conflicted += 1,
            ChangeKind::Untracked => out.untracked += 1,
            _ => {
                if file.staged {
                    out.staged += 1;
                }
                if file.unstaged {
                    out.unstaged += 1;
                }
            }
        }
    }

    // Conflicts first, then staged work, then unstaged, then untracked.
    files.sort_by(|a, b| {
        group_rank(a)
            .cmp(&group_rank(b))
            .then_with(|| a.path.cmp(&b.path))
    });

    out.total_changed = files.len() as u32;
    out.truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    out.files = files;
    out.clean = out.total_changed == 0;
    out
}

fn group_rank(file: &GitFile) -> u8 {
    match file.kind {
        ChangeKind::Conflicted => 0,
        ChangeKind::Untracked => 3,
        _ if file.staged => 1,
        _ => 2,
    }
}

fn parse_header(line: &str, out: &mut GitStatus) {
    let rest = line.trim_start_matches('#').trim();
    let (key, value) = match rest.split_once(' ') {
        Some(pair) => pair,
        None => return,
    };
    let value = value.trim();
    match key {
        "branch.oid" => {
            if value != "(initial)" {
                out.head_short = Some(value.chars().take(7).collect());
            }
        }
        "branch.head" => {
            if value == "(detached)" {
                out.detached = true;
            } else {
                out.branch = Some(value.to_string());
            }
        }
        "branch.upstream" => out.upstream = Some(value.to_string()),
        "branch.ab" => {
            for token in value.split_whitespace() {
                let (sign, digits) = token.split_at(1);
                let count: u32 = digits.parse().unwrap_or(0);
                match sign {
                    "+" => out.ahead = count,
                    "-" => out.behind = count,
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn ordinary_entry(line: &str) -> Option<GitFile> {
    let xy = field(line, 1)?;
    let path = nth_field(line, 9)?;
    Some(build_entry(xy, clean_path(path)))
}

fn renamed_entry(line: &str) -> Option<GitFile> {
    let xy = field(line, 1)?;
    let tail = nth_field(line, 10)?;
    // `<path><TAB><origPath>`; fall back to a space if the tab is absent.
    let new_path = tail.split('\t').next().unwrap_or(tail).trim();
    Some(build_entry(xy, clean_path(new_path)))
}

fn build_entry(xy: &str, path: String) -> GitFile {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let worktree = chars.next().unwrap_or('.');
    let staged = index != '.';
    let unstaged = worktree != '.';
    // The staged change describes the intent best; fall back to the worktree.
    let kind = change_kind(if staged { index } else { worktree });
    GitFile {
        path,
        code: xy.to_string(),
        kind,
        staged,
        unstaged,
    }
}

fn change_kind(code: char) -> ChangeKind {
    match code {
        'A' => ChangeKind::Added,
        'D' => ChangeKind::Deleted,
        'R' => ChangeKind::Renamed,
        'C' => ChangeKind::Copied,
        'T' => ChangeKind::TypeChanged,
        'U' => ChangeKind::Conflicted,
        _ => ChangeKind::Modified,
    }
}

/// Space-separated field at `index`, not including the remainder.
fn field(line: &str, index: usize) -> Option<&str> {
    line.split(' ').nth(index)
}

/// Everything from field `n` onward, so paths containing spaces survive.
fn nth_field(line: &str, n: usize) -> Option<&str> {
    let mut remainder = line;
    for _ in 1..n {
        let (_, rest) = remainder.split_once(' ')?;
        remainder = rest;
    }
    let trimmed = remainder.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Git quotes paths containing unusual characters when `core.quotePath` is on.
fn clean_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].replace("\\\\", "\\")
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLEAN: &str = "\
# branch.oid 3f7a1c9d8e5b4a2f1c0d9e8b7a6f5e4d3c2b1a09
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
";

    #[test]
    fn a_clean_repository_reports_branch_and_no_changes() {
        let s = parse_porcelain_v2(CLEAN);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.head_short.as_deref(), Some("3f7a1c9"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert!(s.clean);
        assert!(!s.detached);
        assert_eq!(s.total_changed, 0);
        assert!(s.files.is_empty());
    }

    #[test]
    fn ahead_and_behind_counts_are_read() {
        let s = parse_porcelain_v2("# branch.head main\n# branch.ab +3 -12\n");
        assert_eq!(s.ahead, 3);
        assert_eq!(s.behind, 12);
    }

    #[test]
    fn a_detached_head_is_flagged_without_a_branch_name() {
        let s = parse_porcelain_v2("# branch.oid abcdef1234\n# branch.head (detached)\n");
        assert!(s.detached);
        assert_eq!(s.branch, None);
        assert_eq!(s.head_short.as_deref(), Some("abcdef1"));
    }

    #[test]
    fn an_initial_commit_has_no_head_sha() {
        let s = parse_porcelain_v2("# branch.oid (initial)\n# branch.head main\n");
        assert_eq!(s.head_short, None);
        assert_eq!(s.branch.as_deref(), Some("main"));
    }

    #[test]
    fn staged_and_unstaged_changes_are_counted_separately() {
        let text = "\
# branch.head main
1 M. N... 100644 100644 100644 aaaa bbbb staged-only.rs
1 .M N... 100644 100644 100644 aaaa bbbb worktree-only.rs
1 MM N... 100644 100644 100644 aaaa bbbb both.rs
";
        let s = parse_porcelain_v2(text);
        assert_eq!(s.staged, 2, "M. and MM");
        assert_eq!(s.unstaged, 2, ".M and MM");
        assert_eq!(s.total_changed, 3);
        assert!(!s.clean);
    }

    #[test]
    fn untracked_and_conflicted_files_are_counted_in_their_own_buckets() {
        let text = "\
# branch.head main
? notes.md
? src/new.ts
u UU N... 100644 100644 100644 100644 aaa bbb ccc merge-me.rs
";
        let s = parse_porcelain_v2(text);
        assert_eq!(s.untracked, 2);
        assert_eq!(s.conflicted, 1);
        assert_eq!(s.staged, 0, "untracked files are not staged");
        assert_eq!(s.total_changed, 3);
    }

    #[test]
    fn change_kinds_are_mapped_from_the_porcelain_codes() {
        let text = "\
1 A. N... 100644 100644 100644 a b added.rs
1 D. N... 100644 100644 100644 a b deleted.rs
1 .T N... 100644 100644 100644 a b retyped.rs
1 .M N... 100644 100644 100644 a b modified.rs
";
        let s = parse_porcelain_v2(text);
        let kind = |p: &str| s.files.iter().find(|f| f.path == p).unwrap().kind;
        assert_eq!(kind("added.rs"), ChangeKind::Added);
        assert_eq!(kind("deleted.rs"), ChangeKind::Deleted);
        assert_eq!(kind("retyped.rs"), ChangeKind::TypeChanged);
        assert_eq!(kind("modified.rs"), ChangeKind::Modified);
    }

    #[test]
    fn a_rename_reports_the_new_path_only() {
        let text =
            "2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new-name.ts\tsrc/old-name.ts\n";
        let s = parse_porcelain_v2(text);
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].path, "src/new-name.ts");
        assert_eq!(s.files[0].kind, ChangeKind::Renamed);
        assert!(s.files[0].staged);
        assert_eq!(s.staged, 1);
    }

    #[test]
    fn paths_containing_spaces_are_preserved() {
        let text = "\
1 .M N... 100644 100644 100644 aaaa bbbb src/my notes file.md
? another dir/with spaces.txt
";
        let s = parse_porcelain_v2(text);
        let paths: Vec<&str> = s.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"src/my notes file.md"), "got {paths:?}");
        assert!(
            paths.contains(&"another dir/with spaces.txt"),
            "got {paths:?}"
        );
    }

    #[test]
    fn quoted_paths_are_unquoted() {
        let text = "? \"strange\\\\name.txt\"\n";
        let s = parse_porcelain_v2(text);
        assert_eq!(s.files[0].path, "strange\\name.txt");
    }

    #[test]
    fn ignored_entries_are_skipped() {
        let s = parse_porcelain_v2("! dist/bundle.js\n? real.txt\n");
        assert_eq!(s.total_changed, 1);
        assert_eq!(s.files[0].path, "real.txt");
    }

    #[test]
    fn files_are_grouped_conflicts_staged_unstaged_untracked() {
        let text = "\
? zzz-untracked.txt
1 .M N... 100644 100644 100644 a b mmm-unstaged.rs
1 M. N... 100644 100644 100644 a b sss-staged.rs
u UU N... 100644 100644 100644 100644 a b c aaa-conflict.rs
";
        let s = parse_porcelain_v2(text);
        let order: Vec<&str> = s.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "aaa-conflict.rs",
                "sss-staged.rs",
                "mmm-unstaged.rs",
                "zzz-untracked.txt"
            ]
        );
    }

    #[test]
    fn the_file_list_is_capped_but_the_counts_stay_exact() {
        let mut text = String::from("# branch.head main\n");
        for i in 0..(MAX_FILES + 25) {
            text.push_str(&format!("? file-{i:04}.txt\n"));
        }
        let s = parse_porcelain_v2(&text);
        assert_eq!(s.files.len(), MAX_FILES);
        assert!(s.truncated);
        assert_eq!(s.untracked as usize, MAX_FILES + 25);
        assert_eq!(s.total_changed as usize, MAX_FILES + 25);
    }

    #[test]
    fn empty_and_malformed_input_does_not_panic() {
        assert!(parse_porcelain_v2("").clean);
        assert!(parse_porcelain_v2("\n\n\n").clean);
        // Truncated entry lines are skipped rather than crashing.
        let s = parse_porcelain_v2("1 M.\n2 R.\nu UU\n?\n# branch.ab oops\n");
        assert_eq!(s.total_changed, 0);
        assert_eq!(s.ahead, 0);
    }

    #[test]
    fn windows_line_endings_are_handled() {
        let s = parse_porcelain_v2("# branch.head main\r\n? a.txt\r\n");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.files[0].path, "a.txt");
    }

    #[test]
    fn status_on_a_non_repository_reports_not_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        let s = status(dir.path());
        // `git` may or may not be installed on the machine running the tests;
        // either way this must be a defined, non-panicking state.
        if s.available {
            assert!(!s.is_repo);
        }
        assert!(s.clean);
        assert!(s.files.is_empty());
    }

    #[test]
    fn status_on_a_missing_directory_is_safe() {
        let s = status(Path::new("C:/definitely/not/here"));
        assert!(!s.is_repo);
        assert!(s.clean);
    }
}
