//! Flag-gated latency instrumentation for the desktop audio pipeline.
//!
//! The number we optimize is "user stops speaking -> transcript delivered".
//! To decide which optimization is worth building (and prove it with real
//! numbers instead of vibes), the budget components log their wall time on the
//! `epicenter::whispering::timing` target when `WHISPERING_TIMING` is set in the
//! environment. Unset (the default, including release builds), every helper is
//! a branch-and-return: no clock read, no allocation, no log line.
//!
//! Read the spans with:
//!
//! ```sh
//! WHISPERING_TIMING=1 bun run --cwd apps/epicenter tauri dev 2>&1 | grep '\[timing\]'
//! ```
//!
//! This module is deliberately shipped *before* the optimizations it measures.
//! Its whole job is to settle, on real hardware, whether the disk round-trip
//! (write + fsync + read + decode) and the cold model load are big enough to be
//! worth removing. See
//! `specs/20260617T170000-desktop-audio-pipeline-greenfield.md`.

use std::sync::OnceLock;
use std::time::Instant;

/// Whether timing logs are enabled. Read once from `WHISPERING_TIMING`; any
/// value (even empty) enables it. Cached so the hot path is a single load.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("WHISPERING_TIMING").is_some())
}

/// Run `f`, logging `[timing] <label> <ms>ms` when enabled. The closure runs
/// unconditionally; only the clock read and the log line are gated, so a
/// disabled span is free. Returns whatever `f` returns, so it wraps `?`-able
/// calls in place: `timing::measure("decode", || decode(bytes))?`.
pub fn measure<T>(label: &str, f: impl FnOnce() -> T) -> T {
    if !enabled() {
        return f();
    }
    let start = Instant::now();
    let out = f();
    log::info!(
        target: "epicenter::whispering::timing",
        "[timing] {label} {:.2}ms",
        start.elapsed().as_secs_f64() * 1000.0,
    );
    out
}

/// Emit a one-off timing note (e.g. a cache hit/miss marker, or a duration
/// already measured elsewhere). Gated by the same flag as [`measure`]. Prefer
/// the [`timing_note!`](crate::timing_note) macro at call sites so the format
/// arguments are only evaluated when timing is on.
pub fn note(message: std::fmt::Arguments<'_>) {
    if enabled() {
        log::info!(target: "epicenter::whispering::timing", "[timing] {message}");
    }
}

/// `log::info!`-style note on the `epicenter::whispering::timing` target, gated by
/// `WHISPERING_TIMING`. The format arguments are evaluated only when timing
/// is enabled.
#[macro_export]
macro_rules! timing_note {
    ($($arg:tt)*) => {
        if $crate::timing::enabled() {
            $crate::timing::note(format_args!($($arg)*));
        }
    };
}
