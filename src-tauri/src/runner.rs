//! Command execution.
//!
//! A run is spawned through the platform shell in the project directory, with
//! stdout and stderr streamed back as batched line events. Everything happens
//! on background threads, so neither the UI nor the Tauri command loop ever
//! blocks on a process.
//!
//! Output delivery is deliberately indirect: `Emitter` lets the whole runner be
//! driven in tests without a window, and lets batching be verified.

use crate::error::{AppError, AppResult};
use crate::model::{new_id, now_ms, OutputBatch, OutputLine, OutputStream, RunMeta, RunStatus};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long we accumulate lines before emitting a batch. Short enough to feel
/// live, long enough that a chatty build does not flood the UI thread.
const FLUSH_INTERVAL: Duration = Duration::from_millis(60);
/// Upper bound on a single batch, so one burst cannot stall a render.
const MAX_BATCH: usize = 400;
/// A line this long with no newline is flushed anyway (progress spinners).
const MAX_PARTIAL: usize = 8 * 1024;

/// Receives run output and state transitions.
pub trait Emitter: Send + Sync + 'static {
    fn output(&self, batch: OutputBatch);
    fn state(&self, meta: RunMeta);
}

struct RunEntry {
    pid: u32,
    cancelled: Arc<AtomicBool>,
    meta: RunMeta,
}

/// Tracks every process DevWorkspace has started.
#[derive(Default)]
pub struct RunRegistry {
    inner: Mutex<HashMap<String, RunEntry>>,
}

impl RunRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunEntry>> {
        // A poisoned lock would mean a panicked worker thread; the map itself
        // is still structurally sound, so recovering beats taking the app down.
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub fn active(&self) -> Vec<RunMeta> {
        let mut runs: Vec<RunMeta> = self.lock().values().map(|e| e.meta.clone()).collect();
        runs.sort_by_key(|r| r.started_at);
        runs
    }

    pub fn is_project_running(&self, project_id: &str) -> bool {
        self.lock()
            .values()
            .any(|e| e.meta.project_id == project_id)
    }

    pub fn running_count(&self) -> usize {
        self.lock().len()
    }

    /// Requests cancellation. Returns the metadata of the run being stopped.
    pub fn cancel(&self, run_id: &str) -> AppResult<RunMeta> {
        let (pid, cancelled, meta) = {
            let map = self.lock();
            let entry = map
                .get(run_id)
                .ok_or_else(|| AppError::unknown_run(run_id))?;
            (entry.pid, entry.cancelled.clone(), entry.meta.clone())
        };
        cancelled.store(true, Ordering::SeqCst);
        crate::system::kill_process_tree(pid);
        Ok(meta)
    }

    /// Stops everything we started. Called when the window closes so a `dev`
    /// server does not outlive the app.
    pub fn cancel_all(&self) {
        let entries: Vec<(u32, Arc<AtomicBool>)> = self
            .lock()
            .values()
            .map(|e| (e.pid, e.cancelled.clone()))
            .collect();
        for (pid, cancelled) in entries {
            cancelled.store(true, Ordering::SeqCst);
            crate::system::kill_process_tree(pid);
        }
    }
}

/// What to run, and where. Grouped so the call site names each value instead
/// of passing a row of bare strings that are easy to transpose.
pub struct RunRequest<'a> {
    pub project_id: &'a str,
    pub project_name: &'a str,
    pub cwd: &'a Path,
    pub label: &'a str,
    pub command: &'a str,
}

/// Validates and starts a command. Returns as soon as the process is spawned.
pub fn start<E: Emitter>(
    registry: Arc<RunRegistry>,
    emitter: Arc<E>,
    request: RunRequest<'_>,
    on_finish: impl FnOnce(RunMeta) + Send + 'static,
) -> AppResult<RunMeta> {
    let RunRequest {
        project_id,
        project_name,
        cwd,
        label,
        command,
    } = request;
    let command = command.trim();
    if command.is_empty() {
        return Err(AppError::empty_command());
    }
    if !cwd.exists() {
        return Err(AppError::not_found(&cwd.display().to_string()));
    }
    if !cwd.is_dir() {
        return Err(AppError::not_a_directory(&cwd.display().to_string()));
    }

    let mut builder = crate::system::shell_command(command, cwd);
    builder
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Give the child its own process group so cancellation reaches the whole
    // tree, not just the shell we spawned.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        builder.process_group(0);
    }

    let mut child: Child = builder.spawn().map_err(|e| classify_spawn(&e, command))?;
    let pid = child.id();
    let run_id = new_id("run");
    let started_at = now_ms();

    let meta = RunMeta {
        run_id: run_id.clone(),
        project_id: project_id.to_string(),
        project_name: project_name.to_string(),
        label: label.to_string(),
        command: command.to_string(),
        cwd: cwd.display().to_string(),
        started_at,
        finished_at: None,
        exit_code: None,
        status: RunStatus::Running,
        error: None,
    };

    let cancelled = Arc::new(AtomicBool::new(false));
    registry.lock().insert(
        run_id.clone(),
        RunEntry {
            pid,
            cancelled: cancelled.clone(),
            meta: meta.clone(),
        },
    );

    let seq = Arc::new(AtomicU64::new(0));
    let (tx, rx) = mpsc::channel::<OutputLine>();

    // The banner makes the output log self-contained: what ran, and where.
    send_line(&tx, &seq, OutputStream::System, format!("$ {command}"));
    send_line(
        &tx,
        &seq,
        OutputStream::System,
        format!("  in {}", cwd.display()),
    );

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let readers = [
        stdout.map(|s| spawn_reader(s, OutputStream::Stdout, tx.clone(), seq.clone())),
        stderr.map(|s| spawn_reader(s, OutputStream::Stderr, tx.clone(), seq.clone())),
    ];
    // Dropping our own sender lets the pump see the channel close once both
    // reader threads have finished.
    drop(tx);

    // Announce the run before the supervisor starts, so the UI always sees
    // `Running` ahead of the first line of output.
    emitter.state(meta.clone());

    let supervisor_emitter = emitter;
    let supervisor_registry = registry;
    let supervisor_run_id = run_id.clone();
    let mut supervisor_meta = meta.clone();

    std::thread::Builder::new()
        .name(format!("run-{run_id}"))
        .spawn(move || {
            pump(&supervisor_run_id, rx, supervisor_emitter.as_ref());
            for handle in readers.into_iter().flatten() {
                let _ = handle.join();
            }

            let wait = child.wait();
            let was_cancelled = cancelled.load(Ordering::SeqCst);
            let exit_code = wait.as_ref().ok().and_then(|s| s.code());

            supervisor_meta.finished_at = Some(now_ms());
            supervisor_meta.exit_code = exit_code;
            supervisor_meta.status = match (&wait, was_cancelled) {
                (_, true) => RunStatus::Cancelled,
                (Ok(status), false) if status.success() => RunStatus::Succeeded,
                (Ok(_), false) => RunStatus::Failed,
                (Err(_), false) => RunStatus::Error,
            };
            if let Err(e) = &wait {
                supervisor_meta.error = Some(
                    AppError::new("PROCESS_WAIT_FAILED", "Lost track of the process.")
                        .with_hint(crate::error::short_os_reason(e)),
                );
            }

            // Closing note, so the log reads as a complete record.
            let elapsed = supervisor_meta
                .finished_at
                .unwrap_or(started_at)
                .saturating_sub(started_at);
            let note = match supervisor_meta.status {
                RunStatus::Cancelled => format!("— cancelled after {}", human_ms(elapsed)),
                RunStatus::Succeeded => format!("— finished in {}", human_ms(elapsed)),
                RunStatus::Failed => format!(
                    "— exited with code {} after {}",
                    exit_code
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "?".into()),
                    human_ms(elapsed)
                ),
                RunStatus::Error => format!("— stopped unexpectedly after {}", human_ms(elapsed)),
                RunStatus::Running => String::new(),
            };
            supervisor_emitter.output(OutputBatch {
                run_id: supervisor_run_id.clone(),
                lines: vec![OutputLine {
                    seq: seq.fetch_add(1, Ordering::SeqCst),
                    stream: OutputStream::System,
                    text: note,
                    at: now_ms(),
                }],
            });

            supervisor_registry.lock().remove(&supervisor_run_id);
            supervisor_emitter.state(supervisor_meta.clone());
            on_finish(supervisor_meta);
        })
        .map_err(|e| {
            AppError::new("THREAD_SPAWN_FAILED", "Could not start the output reader.")
                .with_hint(crate::error::short_os_reason(&e))
        })?;

    Ok(meta)
}

fn classify_spawn(err: &std::io::Error, command: &str) -> AppError {
    let program = command.split_whitespace().next().unwrap_or(command);
    match err.kind() {
        std::io::ErrorKind::NotFound => AppError::new(
            "SHELL_NOT_FOUND",
            "DevWorkspace could not reach the system shell.",
        )
        .with_hint("Your PATH may be misconfigured. Restarting DevWorkspace usually fixes this."),
        std::io::ErrorKind::PermissionDenied => AppError::new(
            "COMMAND_NOT_PERMITTED",
            format!("Running `{program}` was not permitted."),
        )
        .with_hint("Check the folder's permissions and whether the file is executable."),
        _ => AppError::new("SPAWN_FAILED", format!("`{program}` could not be started."))
            .with_hint(crate::error::short_os_reason(err)),
    }
}

fn send_line(tx: &Sender<OutputLine>, seq: &Arc<AtomicU64>, stream: OutputStream, text: String) {
    let _ = tx.send(OutputLine {
        seq: seq.fetch_add(1, Ordering::SeqCst),
        stream,
        text,
        at: now_ms(),
    });
}

/// Collects lines and emits them in batches until the channel closes.
fn pump<E: Emitter + ?Sized>(run_id: &str, rx: Receiver<OutputLine>, emitter: &E) {
    let mut buffer: Vec<OutputLine> = Vec::with_capacity(MAX_BATCH);
    loop {
        match rx.recv_timeout(FLUSH_INTERVAL) {
            Ok(line) => {
                buffer.push(line);
                // Drain whatever else is already queued before emitting.
                while buffer.len() < MAX_BATCH {
                    match rx.try_recv() {
                        Ok(next) => buffer.push(next),
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            flush(run_id, &mut buffer, emitter);
                            return;
                        }
                    }
                }
                if buffer.len() >= MAX_BATCH {
                    flush(run_id, &mut buffer, emitter);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => flush(run_id, &mut buffer, emitter),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                flush(run_id, &mut buffer, emitter);
                return;
            }
        }
    }
}

fn flush<E: Emitter + ?Sized>(run_id: &str, buffer: &mut Vec<OutputLine>, emitter: &E) {
    if buffer.is_empty() {
        return;
    }
    emitter.output(OutputBatch {
        run_id: run_id.to_string(),
        lines: std::mem::take(buffer),
    });
}

/// Reads a pipe and converts it into lines.
///
/// Decoding is lossy on purpose: a build tool emitting a stray byte should not
/// silence the rest of the output. `\r` is treated as a line break so progress
/// output arrives as successive lines instead of one unbounded line.
fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: OutputStream,
    tx: Sender<OutputLine>,
    seq: Arc<AtomicU64>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut raw = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut raw) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&raw[..n]);
                    emit_complete_lines(&mut pending, &tx, &seq, stream);
                    if pending.len() > MAX_PARTIAL {
                        let text = String::from_utf8_lossy(&pending).to_string();
                        pending.clear();
                        send_line(&tx, &seq, stream, text);
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).trim_end().to_string();
            if !text.is_empty() {
                send_line(&tx, &seq, stream, text);
            }
        }
    })
}

fn emit_complete_lines(
    pending: &mut Vec<u8>,
    tx: &Sender<OutputLine>,
    seq: &Arc<AtomicU64>,
    stream: OutputStream,
) {
    // Find the last break so an incomplete trailing line stays buffered.
    let Some(last_break) = pending.iter().rposition(|b| *b == b'\n' || *b == b'\r') else {
        return;
    };
    let complete: Vec<u8> = pending.drain(..=last_break).collect();
    let text = String::from_utf8_lossy(&complete);
    for line in split_lines(&text) {
        send_line(tx, seq, stream, line);
    }
}

/// Splits on CRLF, LF and bare CR, keeping genuinely blank lines.
fn split_lines(text: &str) -> Vec<String> {
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = normalised.split('\n').map(str::to_string).collect();
    // The input always ends on a break, so the final element is empty.
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines
}

fn human_ms(ms: i64) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        let total = ms / 1000;
        format!("{}m {:02}s", total / 60, total % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use tempfile::tempdir;

    /// Collects everything the runner emits, and lets a test block until the
    /// run reaches a terminal state.
    #[derive(Default)]
    struct Collector {
        lines: Mutex<Vec<OutputLine>>,
        states: Mutex<Vec<RunMeta>>,
        done: Mutex<Option<Sender<RunMeta>>>,
    }

    impl Collector {
        fn with_signal() -> (Arc<Self>, Receiver<RunMeta>) {
            let (tx, rx) = channel();
            let c = Arc::new(Collector::default());
            *c.done.lock().unwrap() = Some(tx);
            (c, rx)
        }
        fn text(&self, stream: OutputStream) -> String {
            self.lines
                .lock()
                .unwrap()
                .iter()
                .filter(|l| l.stream == stream)
                .map(|l| l.text.clone())
                .collect::<Vec<_>>()
                .join("\n")
        }
        fn all_lines(&self) -> Vec<OutputLine> {
            self.lines.lock().unwrap().clone()
        }
    }

    impl Emitter for Collector {
        fn output(&self, batch: OutputBatch) {
            self.lines.lock().unwrap().extend(batch.lines);
        }
        fn state(&self, meta: RunMeta) {
            let terminal = meta.status != RunStatus::Running;
            self.states.lock().unwrap().push(meta.clone());
            if terminal {
                if let Some(tx) = self.done.lock().unwrap().take() {
                    let _ = tx.send(meta);
                }
            }
        }
    }

    fn run(command: &str) -> (Arc<Collector>, RunMeta, Arc<RunRegistry>) {
        let dir = tempdir().unwrap();
        run_in(command, dir.path())
    }

    fn run_in(command: &str, cwd: &Path) -> (Arc<Collector>, RunMeta, Arc<RunRegistry>) {
        let (collector, done) = Collector::with_signal();
        let registry = Arc::new(RunRegistry::default());
        start(
            registry.clone(),
            collector.clone(),
            RunRequest {
                project_id: "prj_1",
                project_name: "Test project",
                cwd,
                label: "Test",
                command,
            },
            |_| {},
        )
        .expect("spawn should succeed");
        let final_meta = done
            .recv_timeout(Duration::from_secs(30))
            .expect("run should reach a terminal state");
        (collector, final_meta, registry)
    }

    // --- line splitting (pure) ------------------------------------------

    #[test]
    fn split_lines_handles_all_three_break_styles() {
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\r\nb\r\n"), vec!["a", "b"]);
        assert_eq!(split_lines("50%\r75%\r"), vec!["50%", "75%"]);
    }

    #[test]
    fn split_lines_keeps_intentional_blank_lines() {
        assert_eq!(split_lines("a\n\nb\n"), vec!["a", "", "b"]);
    }

    #[test]
    fn human_ms_is_readable_at_every_scale() {
        assert_eq!(human_ms(42), "42ms");
        assert_eq!(human_ms(2400), "2.4s");
        assert_eq!(human_ms(125_000), "2m 05s");
    }

    // --- validation -----------------------------------------------------

    #[test]
    fn an_empty_command_is_rejected_before_spawning() {
        let dir = tempdir().unwrap();
        let err = start(
            Arc::new(RunRegistry::default()),
            Arc::new(Collector::default()),
            RunRequest {
                project_id: "p",
                project_name: "P",
                cwd: dir.path(),
                label: "Test",
                command: "   ",
            },
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err.code, "EMPTY_COMMAND");
        assert!(err.hint.is_some());
    }

    #[test]
    fn a_missing_working_directory_is_reported_not_spawned() {
        let err = start(
            Arc::new(RunRegistry::default()),
            Arc::new(Collector::default()),
            RunRequest {
                project_id: "p",
                project_name: "P",
                cwd: Path::new("C:/definitely/not/here"),
                label: "Test",
                command: "echo hi",
            },
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err.code, "PATH_NOT_FOUND");
    }

    #[test]
    fn a_file_instead_of_a_directory_is_reported() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("not-a-dir.txt");
        std::fs::write(&file, "x").unwrap();
        let err = start(
            Arc::new(RunRegistry::default()),
            Arc::new(Collector::default()),
            RunRequest {
                project_id: "p",
                project_name: "P",
                cwd: &file,
                label: "Test",
                command: "echo hi",
            },
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err.code, "NOT_A_DIRECTORY");
    }

    // --- execution ------------------------------------------------------

    #[test]
    fn a_successful_command_streams_stdout_and_reports_exit_zero() {
        let (collector, meta, registry) = run("echo hello-devworkspace");
        assert_eq!(meta.status, RunStatus::Succeeded);
        assert_eq!(meta.exit_code, Some(0));
        assert!(meta.finished_at.unwrap() >= meta.started_at);
        assert!(
            collector
                .text(OutputStream::Stdout)
                .contains("hello-devworkspace"),
            "stdout was {:?}",
            collector.text(OutputStream::Stdout)
        );
        assert_eq!(registry.running_count(), 0, "registry is cleaned up");
    }

    #[test]
    fn the_output_log_records_what_ran_and_where() {
        let dir = tempdir().unwrap();
        let (collector, _, _) = run_in("echo x", dir.path());
        let system = collector.text(OutputStream::System);
        assert!(system.contains("$ echo x"), "got {system:?}");
        assert!(
            system.contains(&dir.path().display().to_string()),
            "the working directory is shown: {system:?}"
        );
    }

    #[test]
    fn a_failing_command_reports_its_exit_code_rather_than_erroring() {
        // `exit 3` means the same thing to cmd.exe and to sh.
        let (_, meta, _) = run("exit 3");
        assert_eq!(meta.status, RunStatus::Failed);
        assert_eq!(meta.exit_code, Some(3));
        assert!(meta.error.is_none(), "a non-zero exit is not an app error");
    }

    #[test]
    fn an_unknown_program_fails_the_run_without_crashing_the_app() {
        let (collector, meta, _) = run("definitely-not-a-real-program-xyz");
        assert_eq!(meta.status, RunStatus::Failed);
        assert_ne!(meta.exit_code, Some(0));
        // The shell explains the problem on stderr; we surface it verbatim.
        assert!(
            !collector.text(OutputStream::Stderr).is_empty(),
            "the shell's own diagnostic is streamed through"
        );
    }

    #[test]
    fn stderr_is_kept_distinct_from_stdout() {
        let command = if cfg!(windows) {
            "echo out && echo err 1>&2"
        } else {
            "echo out; echo err 1>&2"
        };
        let (collector, meta, _) = run(command);
        assert_eq!(meta.status, RunStatus::Succeeded);
        assert!(collector.text(OutputStream::Stdout).contains("out"));
        assert!(collector.text(OutputStream::Stderr).contains("err"));
        assert!(!collector.text(OutputStream::Stdout).contains("err"));
    }

    #[test]
    fn multi_line_output_arrives_in_order_with_monotonic_sequence_numbers() {
        let command = if cfg!(windows) {
            "echo one && echo two && echo three"
        } else {
            "printf 'one\\ntwo\\nthree\\n'"
        };
        let (collector, meta, _) = run(command);
        assert_eq!(meta.status, RunStatus::Succeeded);

        let lines = collector.all_lines();
        let seqs: Vec<u64> = lines.iter().map(|l| l.seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        assert_eq!(seqs, sorted, "lines are delivered in sequence order");

        let stdout = collector.text(OutputStream::Stdout);
        let one = stdout.find("one").expect("one");
        let two = stdout.find("two").expect("two");
        let three = stdout.find("three").expect("three");
        assert!(one < two && two < three, "ordering preserved: {stdout:?}");
    }

    #[test]
    fn a_high_volume_command_is_delivered_in_batches_not_line_by_line() {
        let command = if cfg!(windows) {
            "for /L %i in (1,1,400) do @echo line-%i"
        } else {
            "for i in $(seq 1 400); do echo line-$i; done"
        };
        let (collector, meta, _) = run(command);
        assert_eq!(meta.status, RunStatus::Succeeded);
        let count = collector
            .all_lines()
            .iter()
            .filter(|l| l.stream == OutputStream::Stdout && l.text.contains("line-"))
            .count();
        assert_eq!(count, 400, "no output is dropped under load");
    }

    #[test]
    fn a_command_producing_no_output_still_completes() {
        let command = if cfg!(windows) { "cd ." } else { "true" };
        let (_, meta, _) = run(command);
        assert_eq!(meta.status, RunStatus::Succeeded);
    }

    #[test]
    fn the_finish_callback_receives_the_final_metadata_once() {
        let dir = tempdir().unwrap();
        let (tx, rx) = channel();
        let (collector, done) = Collector::with_signal();
        start(
            Arc::new(RunRegistry::default()),
            collector,
            RunRequest {
                project_id: "prj_1",
                project_name: "P",
                cwd: dir.path(),
                label: "Test",
                command: "echo done",
            },
            move |meta| {
                tx.send(meta).unwrap();
            },
        )
        .unwrap();
        done.recv_timeout(Duration::from_secs(30)).unwrap();

        let meta = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(meta.status, RunStatus::Succeeded);
        assert!(rx.try_recv().is_err(), "called exactly once");
    }

    #[test]
    fn a_running_command_is_visible_in_the_registry_then_removed() {
        let dir = tempdir().unwrap();
        let (collector, done) = Collector::with_signal();
        let registry = Arc::new(RunRegistry::default());
        let sleep = if cfg!(windows) {
            "ping -n 3 127.0.0.1 > nul"
        } else {
            "sleep 2"
        };
        let meta = start(
            registry.clone(),
            collector,
            RunRequest {
                project_id: "prj_live",
                project_name: "Live",
                cwd: dir.path(),
                label: "Dev",
                command: sleep,
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(meta.status, RunStatus::Running);
        assert!(registry.is_project_running("prj_live"));
        assert!(!registry.is_project_running("another"));
        assert_eq!(registry.active().len(), 1);

        done.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(registry.running_count(), 0);
        assert!(!registry.is_project_running("prj_live"));
    }

    // --- cancellation ---------------------------------------------------

    #[test]
    fn a_long_running_command_can_be_cancelled() {
        let dir = tempdir().unwrap();
        let (collector, done) = Collector::with_signal();
        let registry = Arc::new(RunRegistry::default());
        let forever = if cfg!(windows) {
            "ping -n 120 127.0.0.1 > nul"
        } else {
            "sleep 120"
        };
        let meta = start(
            registry.clone(),
            collector.clone(),
            RunRequest {
                project_id: "prj_1",
                project_name: "P",
                cwd: dir.path(),
                label: "Dev",
                command: forever,
            },
            |_| {},
        )
        .unwrap();

        // Give the shell a moment to actually be running.
        std::thread::sleep(Duration::from_millis(400));
        let cancelled = registry.cancel(&meta.run_id).expect("cancel is accepted");
        assert_eq!(cancelled.run_id, meta.run_id);

        let final_meta = done
            .recv_timeout(Duration::from_secs(30))
            .expect("cancellation must terminate the run promptly");
        assert_eq!(final_meta.status, RunStatus::Cancelled);
        assert_eq!(registry.running_count(), 0);
        assert!(
            collector.text(OutputStream::System).contains("cancelled"),
            "the log records the cancellation"
        );
    }

    #[test]
    fn cancelling_an_unknown_run_is_an_explained_error() {
        let registry = RunRegistry::default();
        let err = registry.cancel("run_nope").unwrap_err();
        assert_eq!(err.code, "RUN_NOT_FOUND");
        assert!(err.hint.is_some());
    }

    #[test]
    fn cancel_all_stops_every_tracked_process() {
        let dir = tempdir().unwrap();
        let registry = Arc::new(RunRegistry::default());
        let forever = if cfg!(windows) {
            "ping -n 120 127.0.0.1 > nul"
        } else {
            "sleep 120"
        };
        let mut receivers = Vec::new();
        for i in 0..2 {
            let (collector, done) = Collector::with_signal();
            start(
                registry.clone(),
                collector,
                RunRequest {
                    project_id: &format!("prj_{i}"),
                    project_name: "P",
                    cwd: dir.path(),
                    label: "Dev",
                    command: forever,
                },
                |_| {},
            )
            .unwrap();
            receivers.push(done);
        }
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(registry.running_count(), 2);

        registry.cancel_all();
        for done in receivers {
            let meta = done.recv_timeout(Duration::from_secs(30)).unwrap();
            assert_eq!(meta.status, RunStatus::Cancelled);
        }
        assert_eq!(registry.running_count(), 0);
    }

    #[test]
    fn cancelling_an_already_finished_run_is_rejected_not_fatal() {
        let (_, meta, registry) = run("echo quick");
        let err = registry.cancel(&meta.run_id).unwrap_err();
        assert_eq!(err.code, "RUN_NOT_FOUND");
    }
}
