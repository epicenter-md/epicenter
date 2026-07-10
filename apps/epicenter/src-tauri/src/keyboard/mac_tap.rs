//! macOS keyboard tap: the `listen` primitive for the supervisor on macOS,
//! owned in-tree instead of rented from `rdev::listen`.
//!
//! Why this exists. The rustdesk fork of rdev (`src/macos/listen.rs`) attaches
//! its CGEventTap source to `CFRunLoopGetMain()` and then calls
//! `CFRunLoopRun()`, which runs the *calling* thread's run loop. Epicenter
//! spawns the listener on a background thread, where that thread's run loop has
//! no sources, so `CFRunLoopRun()` returns immediately, `listen()` returns
//! `Ok(())` instantly, and the supervisor misreads "registered" as "the tap
//! died" -> five restarts -> a false `Broken`. (rdev's own `grab.rs` uses
//! `CFRunLoopGetCurrent()` and is correct; only the `listen` path is wrong.)
//!
//! This module fixes that by construction, and closes two more gaps neither
//! rdev fork covers:
//! - it adds the tap source to **this** thread's run loop (`CFRunLoop::get_current`)
//!   and blocks here, so `listen` is a real blocking call the supervisor can
//!   trust;
//! - it **re-enables** a tap that macOS silently disabled under load
//!   (`kCGEventTapDisabledByTimeout` / `…ByUserInput`);
//! - it uses the safe `core-graphics` / `core-foundation` wrappers, whose RAII
//!   releases the mach port and run-loop source on return, so restarts do not
//!   leak onto the run loop the way the raw-FFI fork does.
//!
//! It runs purely for its liveness: the supervisor watches whether this tap
//! stays alive under a still-trusted grant to tell `Active` from `Broken` for
//! auto-paste-at-cursor (ADR-0117). The tap is passive (`ListenOnly`) and drops
//! every event; it no longer decodes keys or drives any matcher.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPortRef;
use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};

// `core-graphics` 0.22 wraps `CGEventTapEnable` only as a method on the tap it
// owns; we re-enable from the supervisor loop (which holds the port directly),
// so declare the two raw entry points. They live in the CoreGraphics framework
// that the `core-graphics` crate already links, so no `#[link]` is needed.
extern "C" {
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventTapIsEnabled(tap: CFMachPortRef) -> bool;
}

/// Why the tap could not be created. The supervisor only needs the debug string
/// for its log; it decides restart-vs-untrusted from a fresh `AXIsProcessTrusted`
/// probe, not from this.
#[derive(Debug)]
pub enum TapError {
    /// `CGEventTapCreate` returned null. In practice: Accessibility trust was
    /// lost between the supervisor's gate check and this call.
    Create,
    /// The tap was created but its run-loop source could not be built.
    Source,
}

/// Set when the supervisor wants the active tap to stop; checked each run-loop
/// slice. The supervisor serializes spawns (exactly one tap thread at a time),
/// so a single process-wide flag plus loop ref is sufficient.
static STOP: AtomicBool = AtomicBool::new(false);

/// The run loop of the live tap thread, so `stop` can wake it from another
/// thread (`CFRunLoop` is `Send`/`Sync`). `None` whenever no tap is running.
static ACTIVE_LOOP: Mutex<Option<CFRunLoop>> = Mutex::new(None);

/// Run a passive system-wide keyboard tap on the calling thread and block until
/// it is stopped (`stop`) or fails. Returns `Ok(())` on a clean stop and
/// `Err(TapError)` if the tap could not be created. The tap decodes nothing: the
/// supervisor only needs it to be a real, live tap whose death (under a still-
/// trusted grant) signals a stale grant. This is a real blocking call the
/// supervisor can trust, unlike the `rdev::listen` it replaced.
pub fn listen() -> Result<(), TapError> {
    STOP.store(false, Ordering::SeqCst);

    // `ListenOnly` is load-bearing: a passive listener observes events and cannot
    // swallow them, so keystrokes still reach the foreground app (this is
    // `listen`, not `grab`). The mask is the minimal keyboard set that keeps this
    // a keyboard tap; the callback drops every event, since liveness (not input)
    // is the whole job.
    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![
            CGEventType::KeyDown,
            CGEventType::KeyUp,
            CGEventType::FlagsChanged,
        ],
        // ListenOnly ignores the return value; `None` passes the event on.
        move |_proxy, _event_type, _event| None,
    )
    .map_err(|()| TapError::Create)?;

    let source = tap
        .mach_port
        .create_runloop_source(0)
        .map_err(|()| TapError::Source)?;

    let run_loop = CFRunLoop::get_current();
    // SAFETY: `kCFRunLoop*Mode` are framework string constants, valid for the
    // process lifetime. The source is added to CommonModes so it stays active
    // across modes; the loop is then driven in DefaultMode below.
    let common_modes = unsafe { kCFRunLoopCommonModes };
    let default_mode = unsafe { kCFRunLoopDefaultMode };
    run_loop.add_source(&source, common_modes);
    tap.enable();

    if let Ok(mut active) = ACTIVE_LOOP.lock() {
        *active = Some(run_loop.clone());
    }

    let port = tap.mach_port.as_concrete_TypeRef();
    while !STOP.load(Ordering::SeqCst) {
        // Re-enable a tap macOS disabled under load. Neither rdev fork does
        // this, so a tap timed out once would otherwise stay dead until the next
        // full restart. SAFETY: `port` is the live mach port owned by `tap`,
        // valid for this whole scope.
        unsafe {
            if !CGEventTapIsEnabled(port) {
                CGEventTapEnable(port, true);
            }
        }
        // Bounded slices, not one blocking `run`, so the stop flag and the
        // re-enable probe each get a turn. Events are still delivered the instant
        // they arrive within a slice, so this adds no input latency.
        CFRunLoop::run_in_mode(default_mode, Duration::from_millis(250), false);
    }

    if let Ok(mut active) = ACTIVE_LOOP.lock() {
        *active = None;
    }
    // `tap` and `source` drop here: their RAII wrappers `CFRelease` the mach port
    // and the run-loop source, so a restart starts clean.
    Ok(())
}

/// Ask the live tap (if any) to stop and return from `listen`. Safe to call from
/// any thread and when nothing is running. Called by the supervisor when
/// auto-paste-at-cursor is disabled.
pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
    if let Ok(active) = ACTIVE_LOOP.lock() {
        if let Some(run_loop) = active.as_ref() {
            run_loop.stop();
        }
    }
}
