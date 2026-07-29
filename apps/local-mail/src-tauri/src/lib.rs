//! The Local Mail desktop shell.
//!
//! This shell is the smallest native wrapper around the existing Bun mail
//! engine (`local-mail app`). It owns exactly two things: the window, and the
//! lifetime of the child engine process. It does NOT own Gmail OAuth, token
//! refresh, sync, the SQLite mirror, or the loopback API bearer; those all stay
//! in Bun end to end (ADR-0116). The engine already serves the triage SPA and a
//! same-origin `/api` on `127.0.0.1` and injects the per-launch bearer into the
//! HTML it serves, so the shell only has to point a webview at that origin.
//!
//! Startup, end to end (the ADR-0084 sidecar recipe):
//!
//! 1. `setup()` spawns `bun src/bin.ts app` from the engine's package dir.
//! 2. The engine prints exactly one line to stdout, the loopback origin it now
//!    serves (`http://127.0.0.1:<port>`), and prints it only after the server
//!    is listening. That line is both the discovery signal (which port) and the
//!    readiness signal (it is up), so no separate health poll is needed.
//! 3. On that line, the shell opens a `WebviewUrl::External` window at the
//!    origin. Tauri does not inject its CSP into external pages, so the engine's
//!    own response headers (frame-deny, `no-store`, CSP) remain the security
//!    boundary; the shell adds nothing and subtracts nothing.
//! 4. On app exit (Cmd+Q, or closing the window), the shell kills the engine so
//!    it never outlives the window. ADR-0116: the mirror syncs only while the
//!    app is open; there is no background mail service.
//!
//! The webview never calls `invoke()` (it talks only to its own same-origin
//! `/api` over HTTP), so the shell registers no commands and needs no remote-IPC
//! allowlist. The bearer never transits Rust.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// The spawned Bun mail engine, held so the shell can kill it on exit. `None`
/// until the engine spawns, and taken (leaving `None`) when it is killed.
struct EngineProcess(Mutex<Option<Child>>);

/// The Local Mail package directory (the parent of `src-tauri`), resolved at
/// compile time so the dev-mode `bun src/bin.ts app` runs from the engine's
/// package root and finds `ui/dist` on disk. Used only on the dev launch path
/// (`env!(...)` is a build-machine path, absent from a distributed bundle).
fn engine_package_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always has a parent package dir")
        .to_path_buf()
}

/// Build the command that launches the Bun mail engine, resolving it one way
/// for a dev run and another for a packaged bundle. Either way the shell owns
/// only the window and the child's lifetime; the engine is the same Bun
/// process, the same `app` entrypoint, the same loopback contract (ADR-0116).
///
/// - **Dev (`tauri dev`, a debug build):** run `bun src/bin.ts app` from the
///   engine's source package dir, so iteration needs no compile step and the
///   engine serves `ui/dist` from beside the source. `bun` is on PATH.
/// - **Packaged (a release bundle):** there is no repo beside the app and `bun`
///   may be absent, so spawn the compiled engine sidecar Tauri placed next to
///   this executable (`bundle.externalBin`, `Contents/MacOS/local-mail-engine`)
///   and point it at the SPA Tauri bundled as a resource, via
///   `LOCAL_MAIL_UI_DIST` (the compiled binary's `import.meta.dir` is a virtual
///   path with no `ui/dist` sibling, so it must be told where the SPA lives).
fn engine_command(app: &tauri::AppHandle) -> std::io::Result<Command> {
    let mut command = if cfg!(debug_assertions) {
        let mut command = Command::new("bun");
        command
            .args(["src/bin.ts", "app"])
            .current_dir(engine_package_dir());
        command
    } else {
        let sidecar = std::env::current_exe()?
            .parent()
            .expect("the app executable always has a parent dir")
            .join("local-mail-engine");
        let ui_dist = app
            .path()
            .resource_dir()
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::NotFound, err))?
            .join("ui-dist");
        let mut command = Command::new(sidecar);
        command.arg("app").env("LOCAL_MAIL_UI_DIST", ui_dist);
        command
    };
    // A packaged distribution may compile its Google Desktop client identity
    // into this native shell. It is public application configuration, not a
    // Gmail grant. The Bun engine still owns OAuth end to end, and an inherited
    // GMAIL_* machine override takes precedence inside the engine (ADR-0188).
    if let Some(client_id) = option_env!("LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_ID") {
        command.env("LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_ID", client_id);
    }
    if let Some(client_secret) = option_env!("LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_SECRET") {
        command.env("LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_SECRET", client_secret);
    }
    // stdout piped so the shell can read the printed origin; stderr inherited so
    // the engine's sync/gmail logs stay visible in the launching terminal.
    command.stdout(Stdio::piped()).stderr(Stdio::inherit());
    Ok(command)
}

/// Spawn the Bun mail engine (see [`engine_command`] for how it is resolved).
fn spawn_engine(app: &tauri::AppHandle) -> std::io::Result<Child> {
    engine_command(app)?.spawn()
}

/// Kill the engine if it is still held. SIGKILL is safe by the engine's design:
/// its per-account sync lock is an fcntl lock the kernel releases on process
/// death, and its presence file is stale-safe (it just names a dead port), so a
/// hard kill leaves no corrupt state (ADR-0116).
fn kill_engine(app: &tauri::AppHandle) {
    if let Some(mut child) = app.state::<EngineProcess>().0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EngineProcess(Mutex::new(None)))
        .setup(|app| {
            let mut child = match spawn_engine(app.handle()) {
                Ok(child) => child,
                Err(err) => {
                    eprintln!(
                        "[local-mail shell] failed to spawn the mail engine: {err}. In dev, is `bun` on PATH?"
                    );
                    // Fail the launch rather than run on as an invisible,
                    // windowless app: there is no engine to point a webview at.
                    return Err(err.into());
                }
            };

            let stdout = child
                .stdout
                .take()
                .expect("engine stdout was piped in spawn_engine");
            app.state::<EngineProcess>().0.lock().unwrap().replace(child);

            // setup() is synchronous, so read the engine's stdout on a
            // background thread and open the window on the main thread once the
            // origin line arrives.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let origin = line.trim();
                    // The engine prints only the origin to stdout, but skip any
                    // other line defensively rather than trusting line 1.
                    if !origin.starts_with("http://127.0.0.1:") {
                        continue;
                    }
                    let origin = origin.to_string();
                    let handle = handle.clone();
                    let _ = handle.clone().run_on_main_thread(move || {
                        open_window(&handle, &origin);
                    });
                    return;
                }
                // stdout closed before any origin line: the engine died or never
                // came up. Exit rather than linger as an invisible windowless
                // app; the exit runs kill_engine, so nothing is left behind.
                eprintln!(
                    "[local-mail shell] the mail engine exited before reporting an origin; shutting down."
                );
                handle.exit(1);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Local Mail shell")
        .run(|app, event| {
            // Cmd+Q and `app.exit()` (see `open_window`'s close handler) both
            // reach here; kill the engine so it never outlives the window.
            if let RunEvent::Exit = event {
                kill_engine(app);
            }
        });
}

/// Open the single "main" window pointed at the engine's external origin, and
/// make closing it quit the app (so the engine is killed via `RunEvent::Exit`,
/// including on macOS where a closed window would otherwise keep the app alive).
fn open_window(handle: &tauri::AppHandle, origin: &str) {
    let url = match origin.parse() {
        Ok(url) => url,
        Err(err) => {
            eprintln!("[local-mail shell] engine printed an unparseable origin {origin:?}: {err}");
            handle.exit(1);
            return;
        }
    };
    let window = WebviewWindowBuilder::new(handle, "main", WebviewUrl::External(url))
        .title("Local Mail")
        .inner_size(1200.0, 820.0)
        .min_inner_size(760.0, 520.0)
        .build();
    match window {
        Ok(window) => {
            let quit_handle = handle.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { .. } = event {
                    quit_handle.exit(0);
                }
            });
        }
        Err(err) => {
            eprintln!("[local-mail shell] failed to open the window at {origin}: {err}");
            handle.exit(1);
        }
    }
}
