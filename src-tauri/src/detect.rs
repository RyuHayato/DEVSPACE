//! Project detection.
//!
//! Reads the marker files at a project root to work out what kind of project
//! it is, and turns that into sensible default commands. Everything that does
//! real inference is a pure function over already-read data so it can be
//! tested without touching the filesystem.

use crate::model::{new_id, CommandDef, CommandKind, CommandSource, Detection, ScriptEntry};
use std::collections::BTreeSet;
use std::path::Path;

/// Marker files we look for at the project root.
const MARKERS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "deno.json",
    "deno.jsonc",
    "composer.json",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Makefile",
    "justfile",
    "Dockerfile",
    "docker-compose.yml",
];

const LOCKFILES: &[(&str, &str)] = &[
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lockb", "bun"),
    ("bun.lock", "bun"),
    ("package-lock.json", "npm"),
];

const MAX_SCRIPTS: usize = 40;

/// Falls back through the path components so a trailing separator or a drive
/// root still yields something printable.
pub fn name_from_path(path: &str) -> String {
    let normalised = path.replace('\\', "/");
    let trimmed = normalised.trim_end_matches('/');
    let candidate = trimmed.rsplit('/').find(|seg| !seg.is_empty());
    match candidate {
        Some(seg) if !seg.is_empty() => seg.trim_end_matches(':').to_string(),
        _ => "Project".to_string(),
    }
}

/// Inspects a directory on disk. Never fails: an unreadable project simply
/// reports no markers, which the UI renders as an "unknown" project type.
pub fn detect(root: &Path) -> Detection {
    let mut markers: Vec<String> = Vec::new();
    for marker in MARKERS {
        if root.join(marker).exists() {
            markers.push((*marker).to_string());
        }
    }
    let has_git = root.join(".git").exists();

    let package_json = read_json(&root.join("package.json"));
    let cargo_toml = std::fs::read_to_string(root.join("Cargo.toml")).ok();
    let pyproject = std::fs::read_to_string(root.join("pyproject.toml")).ok();

    let mut package_manager = LOCKFILES
        .iter()
        .find(|(file, _)| root.join(file).exists())
        .map(|(_, pm)| (*pm).to_string());

    // `packageManager: "pnpm@9"` is more authoritative than a stray lockfile.
    if let Some(pkg) = &package_json {
        if let Some(declared) = pkg.get("packageManager").and_then(|v| v.as_str()) {
            let name = declared.split('@').next().unwrap_or("").trim();
            if !name.is_empty() {
                package_manager = Some(name.to_string());
            }
        }
    }
    if package_manager.is_none() && package_json.is_some() {
        package_manager = Some("npm".to_string());
    }

    let scripts = package_json.as_ref().map(read_scripts).unwrap_or_default();

    let ecosystems = infer_ecosystems(&markers);
    let primary_language = primary_language(&ecosystems);
    let project_type = project_type(
        &ecosystems,
        package_json.as_ref(),
        cargo_toml.as_deref(),
        pyproject.as_deref(),
        root,
    );

    let suggested = suggest(&ecosystems, package_manager.as_deref(), &scripts, root)
        .into_iter()
        .map(|(label, program, kind)| CommandDef {
            id: new_id("cmd"),
            label,
            program,
            kind,
            source: CommandSource::Detected,
        })
        .collect();

    Detection {
        markers,
        ecosystems,
        primary_language,
        package_manager,
        project_type,
        scripts,
        has_git,
        suggested,
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_scripts(package_json: &serde_json::Value) -> Vec<ScriptEntry> {
    let Some(map) = package_json.get("scripts").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(name, value)| {
            let command = value.as_str()?.trim();
            if command.is_empty() {
                return None;
            }
            Some(ScriptEntry {
                name: name.clone(),
                command: command.to_string(),
            })
        })
        .take(MAX_SCRIPTS)
        .collect()
}

/// Maps marker files to ecosystem identifiers, de-duplicated and stable.
pub fn infer_ecosystems(markers: &[String]) -> Vec<String> {
    let mut found: BTreeSet<&str> = BTreeSet::new();
    for marker in markers {
        match marker.as_str() {
            "package.json" => {
                found.insert("node");
            }
            "deno.json" | "deno.jsonc" => {
                found.insert("deno");
            }
            "Cargo.toml" => {
                found.insert("rust");
            }
            "pyproject.toml" | "requirements.txt" => {
                found.insert("python");
            }
            "go.mod" => {
                found.insert("go");
            }
            "composer.json" => {
                found.insert("php");
            }
            "Gemfile" => {
                found.insert("ruby");
            }
            "pom.xml" | "build.gradle" | "build.gradle.kts" => {
                found.insert("jvm");
            }
            "Dockerfile" | "docker-compose.yml" => {
                found.insert("docker");
            }
            "Makefile" | "justfile" => {
                found.insert("make");
            }
            _ => {}
        }
    }
    // Order by how strongly the marker identifies the project, not alphabet.
    const PRIORITY: &[&str] = &[
        "node", "deno", "rust", "python", "go", "jvm", "ruby", "php", "make", "docker",
    ];
    let mut out: Vec<String> = PRIORITY
        .iter()
        .filter(|p| found.contains(**p))
        .map(|p| (*p).to_string())
        .collect();
    for extra in found {
        if !PRIORITY.contains(&extra) {
            out.push(extra.to_string());
        }
    }
    out
}

pub fn primary_language(ecosystems: &[String]) -> Option<String> {
    let first = ecosystems.first()?;
    Some(
        match first.as_str() {
            "node" => "TypeScript / JavaScript",
            "deno" => "TypeScript",
            "rust" => "Rust",
            "python" => "Python",
            "go" => "Go",
            "jvm" => "Java / Kotlin",
            "ruby" => "Ruby",
            "php" => "PHP",
            "make" => "Makefile",
            "docker" => "Docker",
            other => other,
        }
        .to_string(),
    )
}

/// A short human label such as "Next.js" or "Cargo workspace".
fn project_type(
    ecosystems: &[String],
    package_json: Option<&serde_json::Value>,
    cargo_toml: Option<&str>,
    pyproject: Option<&str>,
    root: &Path,
) -> Option<String> {
    if let Some(pkg) = package_json {
        if let Some(label) = node_framework(pkg) {
            return Some(label);
        }
    }
    if let Some(cargo) = cargo_toml {
        if cargo.contains("[workspace]") {
            return Some("Cargo workspace".into());
        }
        if root.join("src/main.rs").exists() {
            return Some("Rust binary".into());
        }
        if root.join("src/lib.rs").exists() {
            return Some("Rust library".into());
        }
        return Some("Cargo package".into());
    }
    if let Some(py) = pyproject {
        if py.contains("[tool.poetry]") {
            return Some("Poetry project".into());
        }
        if py.contains("[tool.hatch") {
            return Some("Hatch project".into());
        }
        return Some("Python project".into());
    }
    match ecosystems.first().map(String::as_str) {
        Some("go") => Some("Go module".into()),
        Some("node") => Some("Node package".into()),
        Some("deno") => Some("Deno project".into()),
        Some("python") => Some("Python project".into()),
        Some("make") => Some("Makefile project".into()),
        Some("docker") => Some("Docker project".into()),
        _ => None,
    }
}

/// Recognises the framework from dependencies, most specific first.
fn node_framework(pkg: &serde_json::Value) -> Option<String> {
    let mut deps: BTreeSet<String> = BTreeSet::new();
    for key in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(map) = pkg.get(key).and_then(|v| v.as_object()) {
            deps.extend(map.keys().cloned());
        }
    }
    let has = |name: &str| deps.contains(name);

    // Order matters: Next.js also depends on React.
    let framework = if has("@tauri-apps/api") || has("@tauri-apps/cli") {
        Some("Tauri app")
    } else if has("next") {
        Some("Next.js")
    } else if has("nuxt") {
        Some("Nuxt")
    } else if has("astro") {
        Some("Astro")
    } else if has("@remix-run/react") {
        Some("Remix")
    } else if has("@sveltejs/kit") {
        Some("SvelteKit")
    } else if has("electron") {
        Some("Electron app")
    } else if has("expo") {
        Some("Expo app")
    } else if has("react-native") {
        Some("React Native")
    } else if has("vite") && has("react") {
        Some("Vite · React")
    } else if has("vite") && has("vue") {
        Some("Vite · Vue")
    } else if has("vite") && has("svelte") {
        Some("Vite · Svelte")
    } else if has("vite") {
        Some("Vite app")
    } else if has("react") {
        Some("React app")
    } else if has("nestjs") || has("@nestjs/core") {
        Some("NestJS service")
    } else if has("fastify") {
        Some("Fastify service")
    } else if has("express") {
        Some("Express service")
    } else {
        None
    };
    framework.map(str::to_string)
}

/// Builds the default command set. Pure, so the mapping is directly testable.
pub fn suggest(
    ecosystems: &[String],
    package_manager: Option<&str>,
    scripts: &[ScriptEntry],
    root: &Path,
) -> Vec<(String, String, CommandKind)> {
    let mut out: Vec<(String, String, CommandKind)> = Vec::new();

    if ecosystems.iter().any(|e| e == "node") {
        let pm = package_manager.unwrap_or("npm");
        let has_script = |name: &str| scripts.iter().any(|s| s.name == name);

        // `dev` is the conventional name; `start` is the common fallback.
        let dev_script = ["dev", "start", "serve"]
            .iter()
            .find(|name| has_script(name));
        if let Some(name) = dev_script {
            out.push(("Dev".into(), run_script(pm, name), CommandKind::Dev));
        }
        if has_script("test") {
            out.push(("Test".into(), test_command(pm), CommandKind::Test));
        }
        if has_script("build") {
            out.push(("Build".into(), run_script(pm, "build"), CommandKind::Build));
        }
        for name in ["lint", "typecheck", "check"] {
            if has_script(name) {
                out.push((title_case(name), run_script(pm, name), CommandKind::Lint));
            }
        }
        out.push(("Install".into(), install_command(pm), CommandKind::Install));
    }

    if ecosystems.iter().any(|e| e == "rust") {
        let is_bin = root.join("src/main.rs").exists();
        if is_bin {
            out.push(("Run".into(), "cargo run".into(), CommandKind::Dev));
        }
        out.push(("Test".into(), "cargo test".into(), CommandKind::Test));
        out.push((
            "Build".into(),
            "cargo build --release".into(),
            CommandKind::Build,
        ));
        out.push((
            "Clippy".into(),
            "cargo clippy --all-targets".into(),
            CommandKind::Lint,
        ));
    }

    if ecosystems.iter().any(|e| e == "python") {
        let poetry = std::fs::read_to_string(root.join("pyproject.toml"))
            .map(|s| s.contains("[tool.poetry]"))
            .unwrap_or(false);
        let prefix = if poetry { "poetry run " } else { "" };
        out.push(("Test".into(), format!("{prefix}pytest"), CommandKind::Test));
        if root.join("main.py").exists() {
            out.push((
                "Run".into(),
                format!("{prefix}python main.py"),
                CommandKind::Dev,
            ));
        }
        if !poetry && root.join("requirements.txt").exists() {
            out.push((
                "Install".into(),
                "pip install -r requirements.txt".into(),
                CommandKind::Install,
            ));
        }
    }

    if ecosystems.iter().any(|e| e == "go") {
        out.push(("Run".into(), "go run .".into(), CommandKind::Dev));
        out.push(("Test".into(), "go test ./...".into(), CommandKind::Test));
        out.push(("Build".into(), "go build ./...".into(), CommandKind::Build));
        out.push(("Vet".into(), "go vet ./...".into(), CommandKind::Lint));
    }

    if out.is_empty() && ecosystems.iter().any(|e| e == "make") {
        out.push(("Make".into(), "make".into(), CommandKind::Build));
    }

    // Keep the most useful command of each kind at the top, stable otherwise.
    out.sort_by_key(|(_, _, kind)| kind.rank());
    out
}

fn run_script(pm: &str, script: &str) -> String {
    match pm {
        "deno" => format!("deno task {script}"),
        "bun" => format!("bun run {script}"),
        other => format!("{other} run {script}"),
    }
}

/// `npm test` and `yarn test` are idiomatic; pnpm/bun prefer `run`.
fn test_command(pm: &str) -> String {
    match pm {
        "npm" | "yarn" => format!("{pm} test"),
        other => run_script(other, "test"),
    }
}

fn install_command(pm: &str) -> String {
    match pm {
        "npm" => "npm install".into(),
        "yarn" => "yarn".into(),
        other => format!("{other} install"),
    }
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn scripts(names: &[(&str, &str)]) -> Vec<ScriptEntry> {
        names
            .iter()
            .map(|(n, c)| ScriptEntry {
                name: (*n).to_string(),
                command: (*c).to_string(),
            })
            .collect()
    }

    #[test]
    fn name_from_path_handles_separators_and_edge_cases() {
        assert_eq!(name_from_path("C:\\code\\zarchat"), "zarchat");
        assert_eq!(name_from_path("C:/code/zarchat/"), "zarchat");
        assert_eq!(name_from_path("/home/dev/lumen"), "lumen");
        assert_eq!(name_from_path("C:\\"), "C");
        assert_eq!(name_from_path(""), "Project");
        assert_eq!(name_from_path("/"), "Project");
    }

    #[test]
    fn ecosystems_are_ordered_by_significance_not_alphabet() {
        let markers = vec![
            "Dockerfile".to_string(),
            "Cargo.toml".to_string(),
            "package.json".to_string(),
        ];
        assert_eq!(infer_ecosystems(&markers), vec!["node", "rust", "docker"]);
    }

    #[test]
    fn duplicate_markers_collapse_to_one_ecosystem() {
        let markers = vec!["pyproject.toml".to_string(), "requirements.txt".to_string()];
        assert_eq!(infer_ecosystems(&markers), vec!["python"]);
    }

    #[test]
    fn node_suggestions_follow_the_detected_package_manager() {
        let root = tempdir().unwrap();
        let got = suggest(
            &["node".to_string()],
            Some("pnpm"),
            &scripts(&[("dev", "vite"), ("test", "vitest"), ("build", "vite build")]),
            root.path(),
        );
        let programs: Vec<&str> = got.iter().map(|(_, p, _)| p.as_str()).collect();
        assert_eq!(
            programs,
            vec![
                "pnpm run dev",
                "pnpm run test",
                "pnpm run build",
                "pnpm install"
            ]
        );
    }

    #[test]
    fn npm_uses_the_idiomatic_bare_test_command() {
        let root = tempdir().unwrap();
        let got = suggest(
            &["node".to_string()],
            Some("npm"),
            &scripts(&[("test", "vitest")]),
            root.path(),
        );
        assert!(got.iter().any(|(_, p, _)| p == "npm test"));
    }

    #[test]
    fn start_is_used_when_there_is_no_dev_script() {
        let root = tempdir().unwrap();
        let got = suggest(
            &["node".to_string()],
            Some("npm"),
            &scripts(&[("start", "node server.js")]),
            root.path(),
        );
        assert!(got
            .iter()
            .any(|(l, p, k)| l == "Dev" && p == "npm run start" && *k == CommandKind::Dev));
    }

    #[test]
    fn missing_scripts_are_never_suggested() {
        let root = tempdir().unwrap();
        let got = suggest(&["node".to_string()], Some("npm"), &[], root.path());
        // Only install, which does not depend on a script existing.
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].2, CommandKind::Install);
    }

    #[test]
    fn rust_binary_gets_a_run_command_but_a_library_does_not() {
        let bin = tempdir().unwrap();
        fs::create_dir_all(bin.path().join("src")).unwrap();
        fs::write(bin.path().join("src/main.rs"), "fn main(){}").unwrap();
        let got = suggest(&["rust".to_string()], None, &[], bin.path());
        assert!(got.iter().any(|(l, _, _)| l == "Run"));

        let lib = tempdir().unwrap();
        let got = suggest(&["rust".to_string()], None, &[], lib.path());
        assert!(!got.iter().any(|(l, _, _)| l == "Run"));
        assert!(got.iter().any(|(_, p, _)| p == "cargo test"));
    }

    #[test]
    fn poetry_projects_prefix_commands_with_poetry_run() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("pyproject.toml"), "[tool.poetry]\nname='x'").unwrap();
        let got = suggest(&["python".to_string()], None, &[], dir.path());
        assert!(got.iter().any(|(_, p, _)| p == "poetry run pytest"));
    }

    #[test]
    fn suggestions_are_ordered_dev_test_build() {
        let root = tempdir().unwrap();
        let got = suggest(&["go".to_string()], None, &[], root.path());
        let kinds: Vec<CommandKind> = got.iter().map(|(_, _, k)| *k).collect();
        assert_eq!(
            kinds,
            vec![
                CommandKind::Dev,
                CommandKind::Test,
                CommandKind::Build,
                CommandKind::Lint
            ]
        );
    }

    #[test]
    fn detects_a_vite_react_project_end_to_end() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"name":"web","scripts":{"dev":"vite","build":"vite build","test":"vitest"},
                "devDependencies":{"vite":"^6","react":"^19"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();

        let d = detect(dir.path());
        assert_eq!(d.package_manager.as_deref(), Some("pnpm"));
        assert_eq!(d.project_type.as_deref(), Some("Vite · React"));
        assert_eq!(
            d.primary_language.as_deref(),
            Some("TypeScript / JavaScript")
        );
        assert!(d.has_git);
        assert_eq!(d.scripts.len(), 3);
        assert!(d
            .suggested
            .iter()
            .all(|c| c.source == CommandSource::Detected));
        assert!(d.suggested.iter().any(|c| c.program == "pnpm run dev"));
    }

    #[test]
    fn package_manager_field_beats_a_stray_lockfile() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"packageManager":"yarn@4.1.0","scripts":{"test":"jest"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("package-lock.json"), "{}").unwrap();
        let d = detect(dir.path());
        assert_eq!(d.package_manager.as_deref(), Some("yarn"));
    }

    #[test]
    fn tauri_is_recognised_ahead_of_its_ui_framework() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"dependencies":{"react":"^19","@tauri-apps/api":"^2","vite":"^6"}}"#,
        )
        .unwrap();
        assert_eq!(
            detect(dir.path()).project_type.as_deref(),
            Some("Tauri app")
        );
    }

    #[test]
    fn next_is_recognised_ahead_of_react() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"dependencies":{"next":"^15","react":"^19"}}"#,
        )
        .unwrap();
        assert_eq!(detect(dir.path()).project_type.as_deref(), Some("Next.js"));
    }

    #[test]
    fn cargo_workspace_is_labelled_as_such() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("Cargo.toml"), "[workspace]\nmembers=[]").unwrap();
        assert_eq!(
            detect(dir.path()).project_type.as_deref(),
            Some("Cargo workspace")
        );
    }

    #[test]
    fn malformed_package_json_does_not_break_detection() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("package.json"), "{ not json at all").unwrap();
        let d = detect(dir.path());
        assert!(d.markers.contains(&"package.json".to_string()));
        assert!(d.scripts.is_empty());
        // Still identified as a node project from the marker alone.
        assert_eq!(d.ecosystems, vec!["node"]);
    }

    #[test]
    fn an_empty_directory_detects_nothing_without_panicking() {
        let dir = tempdir().unwrap();
        let d = detect(dir.path());
        assert!(d.markers.is_empty());
        assert!(d.ecosystems.is_empty());
        assert!(d.project_type.is_none());
        assert!(d.suggested.is_empty());
        assert!(!d.has_git);
    }

    #[test]
    fn a_missing_directory_detects_nothing_without_panicking() {
        let d = detect(Path::new("C:/definitely/not/here/at/all"));
        assert!(d.markers.is_empty());
        assert!(d.suggested.is_empty());
    }
}
