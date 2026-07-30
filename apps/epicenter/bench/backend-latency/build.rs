//! Capture the build identity the benchmark result is only meaningful next to,
//! and make a shared-posture binary runnable.
//!
//! Two jobs:
//!
//! 1. **Record the posture from the native build itself, not from our features.**
//!    `transcribe-cpp-sys` only emits `runtime_dir`/`module_dir` when it produced
//!    separate runtime files, so their presence is direct evidence of static vs
//!    shared vs loadable-module linkage. That beats re-deriving it from Cargo
//!    features, which describe intent rather than outcome, and it is why the
//!    harness needs no wrapper script to tell it what it is.
//!
//! 2. **Bake the rpath a shared build needs.** `cargo:rustc-link-arg` does not
//!    propagate from a dependency, so the rpath `transcribe-cpp` emits for its
//!    own tests never reaches this binary. Same fix the app's build script
//!    applies for the bundle; here it only has to work in place.
//!
//! The ISA settings that decide whether a CPU measurement represents a shippable
//! binary or just this build host arrive through `TRANSCRIBE_CMAKE_ARGS`, which
//! the sys crate forwards to CMake. Cargo cannot see them, so record them here
//! verbatim and let the harness report whether they pin anything at all.

use std::env;
use std::path::Path;

fn main() {
    record_native_posture();
    record_isa_and_toolchain();
    bake_shared_rpath();
}

/// Report how the native library was actually linked, read off the sys crate's
/// own output metadata rather than our feature flags.
fn record_native_posture() {
    for key in ["RUNTIME_DIR", "MODULE_DIR", "LIB_DIR"] {
        println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_{key}");
    }

    // A static build bakes every backend into this binary and so produces no
    // runtime files to ship; a plain shared build produces the library but no
    // loadable modules; only dynamic-backends produces a module directory.
    let has_runtime = env::var_os("DEP_TRANSCRIBE_CPP_RUNTIME_DIR").is_some();
    let has_modules = env::var_os("DEP_TRANSCRIBE_CPP_MODULE_DIR").is_some();
    let native_link = match (has_runtime, has_modules) {
        (false, _) => "static",
        (true, false) => "shared",
        (true, true) => "dynamic-backends",
    };
    println!("cargo:rustc-env=BENCH_NATIVE_LINK={native_link}");

    // The directory a dynamic-backends build must find its compute modules in.
    // Recorded because "zero devices registered" is the headline failure mode of
    // that posture, and the first question is always which directory was scanned.
    let module_dir = env::var("DEP_TRANSCRIBE_CPP_MODULE_DIR").unwrap_or_default();
    println!("cargo:rustc-env=BENCH_MODULE_DIR={module_dir}");
}

/// Record the CMake arguments that decide the compiled ISA floor.
///
/// This is the difference between a distributable measurement and a measurement
/// of this build host. In a static build nothing forces `GGML_NATIVE=OFF`, so
/// ggml defaults it ON and compiles `-march=native`. A dynamic-backends build
/// cannot do that (transcribe.cpp force-sets `GGML_NATIVE=OFF` because ggml
/// hard-errors on native tuning plus feature-scored modules), so the two
/// postures are not comparable unless a static build is pinned by hand.
fn record_isa_and_toolchain() {
    for var in ["TRANSCRIBE_CMAKE_ARGS", "CMAKE_ARGS"] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    let cmake_args = env::var("TRANSCRIBE_CMAKE_ARGS")
        .or_else(|_| env::var("CMAKE_ARGS"))
        .unwrap_or_default();

    // Only claim the ISA is pinned when the arguments actually say so. Anything
    // vaguer would let an unpinned native build present itself as distributable.
    let disables_native = cmake_args.contains("GGML_NATIVE=OFF")
        || cmake_args.contains("TRANSCRIBE_X86_CONSERVATIVE=ON");
    println!("cargo:rustc-env=BENCH_CMAKE_ARGS={cmake_args}");
    println!("cargo:rustc-env=BENCH_ISA_PINNED={disables_native}");

    println!(
        "cargo:rustc-env=BENCH_TARGET={}",
        env::var("TARGET").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=BENCH_PROFILE={}",
        env::var("PROFILE").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=BENCH_OPT_LEVEL={}",
        env::var("OPT_LEVEL").unwrap_or_default()
    );
}

/// Let a shared or dynamic-backends build of this binary find `libtranscribe`
/// where cargo left it. Windows needs nothing: the sys crate stages its DLLs
/// into the profile directory, which is where the executable lands.
fn bake_shared_rpath() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        return;
    }
    if env::var_os("DEP_TRANSCRIBE_CPP_RUNTIME_DIR").is_none() {
        return;
    }
    let Some(lib_dir) = env::var_os("DEP_TRANSCRIBE_CPP_LIB_DIR") else {
        return;
    };
    println!(
        "cargo:rustc-link-arg=-Wl,-rpath,{}",
        Path::new(&lib_dir).display()
    );
}
