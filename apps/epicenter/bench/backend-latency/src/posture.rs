//! What this binary is, so a latency number can never be read without it.
//!
//! Two halves that answer different questions. The build half is compile-time
//! and answers "would this number survive being shipped" (static or dynamic,
//! and whether the ISA was pinned or tuned to the build host). The runtime half
//! is what the loaded library actually reports about the machine, and it is the
//! half that catches a dynamic build that registered zero compute devices.

use serde_json::{json, Value};
use transcribe_cpp::{backend_available, devices, Backend};

/// Exactly one posture, checked at compile time in main.rs.
pub const POSTURE: &str = if cfg!(feature = "static-metal") {
    "static-metal"
} else if cfg!(feature = "dynamic-vulkan") {
    "dynamic-vulkan"
} else {
    "static-cpu"
};

/// The compile-time identity, gathered by build.rs.
///
/// `isa_pinned` is the field to read first on any x86 CPU result. False means
/// ggml compiled `-march=native` and the number describes the build host, not a
/// binary you could hand to someone else.
pub fn build() -> Value {
    json!({
        "posture_feature": POSTURE,
        "native_link": env!("BENCH_NATIVE_LINK"),
        "target": env!("BENCH_TARGET"),
        "profile": env!("BENCH_PROFILE"),
        "opt_level": env!("BENCH_OPT_LEVEL"),
        "cmake_args": env!("BENCH_CMAKE_ARGS"),
        "isa_pinned": env!("BENCH_ISA_PINNED") == "true",
        "module_dir": env!("BENCH_MODULE_DIR"),
        "transcribe_cpp_compiled": transcribe_cpp::compiled_version(),
        "transcribe_cpp_runtime": transcribe_cpp::version(),
        "transcribe_cpp_commit": transcribe_cpp::version_commit(),
        "abi_header_hash": transcribe_cpp::header_hash(),
    })
}

/// Register the compute backends the way the app does, then report what showed
/// up.
///
/// A static build has its backends compiled in and this is a no-op; a
/// dynamic-backends build has no backend at all until the modules load, so a
/// missing module directory yields zero devices here rather than a confusing
/// failure inside the first model load. Same call the app makes on first use.
pub fn initialize_backends() -> Result<(), String> {
    transcribe_cpp::init_backends_default().map_err(|error| {
        format!(
            "init_backends_default failed in the {POSTURE} posture (module dir \
             {:?}): {error}",
            env!("BENCH_MODULE_DIR")
        )
    })
}

/// The machine as the loaded library sees it.
pub fn runtime(requested: Backend, n_threads: i32) -> Value {
    let devices: Vec<Value> = devices()
        .into_iter()
        .map(|device| {
            json!({
                "index": device.index,
                "name": device.name,
                "description": device.description,
                "kind": device.kind,
                "device_type": format!("{:?}", device.device_type),
                "device_id": device.device_id,
                "memory_total": device.memory_total,
            })
        })
        .collect();

    json!({
        "backend_requested": backend_name(requested),
        "n_threads_requested": n_threads,
        "available_parallelism": std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(0),
        "device_count": devices.len(),
        "devices": devices,
        "backend_available": {
            "cpu": backend_available(Backend::Cpu),
            "cpu_accel": backend_available(Backend::CpuAccel),
            "metal": backend_available(Backend::Metal),
            "vulkan": backend_available(Backend::Vulkan),
            "cuda": backend_available(Backend::Cuda),
        },
    })
}

pub fn backend_name(backend: Backend) -> &'static str {
    match backend {
        Backend::Auto => "auto",
        Backend::Cpu => "cpu",
        Backend::CpuAccel => "cpu-accel",
        Backend::Metal => "metal",
        Backend::Vulkan => "vulkan",
        Backend::Cuda => "cuda",
    }
}

pub fn parse_backend(name: &str) -> Result<Backend, String> {
    match name {
        "auto" => Ok(Backend::Auto),
        "cpu" => Ok(Backend::Cpu),
        "cpu-accel" => Ok(Backend::CpuAccel),
        "metal" => Ok(Backend::Metal),
        "vulkan" => Ok(Backend::Vulkan),
        "cuda" => Ok(Backend::Cuda),
        other => Err(format!(
            "unknown backend {other:?}; expected auto, cpu, cpu-accel, metal, \
             vulkan, or cuda"
        )),
    }
}
