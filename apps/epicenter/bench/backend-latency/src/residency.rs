//! Host and device residency snapshots around the two model loads.
//!
//! RSS and backend memory answer different questions. RSS is what the operating
//! system attributes to this process; `Model::device()` is the backend's live
//! view of the device that owns the weights. On Metal those views overlap
//! because memory is unified, but neither is a substitute for the other.

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;

use serde_json::{json, Value};
use transcribe_cpp::{devices, Device, Model};

/// The instrument is part of the result because an RSS number without its
/// collection method is not portable evidence.
pub fn instrument() -> Value {
    if cfg!(target_os = "macos") {
        json!({
            "rss": "ps -o rss= -p <pid>, reported KiB converted to bytes",
            "device_memory": "Model::device().memory_free live snapshot",
            "note": "Metal uses unified memory; GPU allocations may not be fully attributed to process RSS.",
        })
    } else if cfg!(target_os = "linux") {
        json!({
            "rss": "/proc/self/statm resident pages multiplied by getconf PAGESIZE",
            "device_memory": "Model::device().memory_free live snapshot",
            "note": "Device memory is backend-defined and must only be compared within one device and run.",
        })
    } else {
        json!({
            "rss": "unsupported",
            "device_memory": "Model::device().memory_free live snapshot",
            "note": "This harness has an RSS instrument only for macOS and Linux.",
        })
    }
}

/// Sample RSS, the registered devices, and any loaded model's resolved device.
pub fn sample(model_a: Option<&Model>, model_b: Option<&Model>) -> Result<Value, String> {
    let (rss, rss_error) = match rss_bytes() {
        Ok(bytes) => (Some(bytes), None),
        Err(error) => (None, Some(error)),
    };
    Ok(json!({
        "rss_bytes": rss,
        "rss_error": rss_error,
        "registered_devices": devices().iter().map(device).collect::<Vec<_>>(),
        "model_a_device": model_a.map(Model::device).transpose()
            .map_err(|error| format!("query model A device: {error}"))?
            .as_ref().map(device),
        "model_b_device": model_b.map(Model::device).transpose()
            .map_err(|error| format!("query model B device: {error}"))?
            .as_ref().map(device),
    }))
}

pub fn added_cost(after_a: &Value, after_b: &Value) -> Value {
    let rss_cost = after_a["rss_bytes"]
        .as_u64()
        .zip(after_b["rss_bytes"].as_u64())
        .map(|(rss_a, rss_b)| i128::from(rss_b) - i128::from(rss_a));
    let model_b_device = &after_b["model_b_device"];
    let free_before_b = after_a["registered_devices"]
        .as_array()
        .and_then(|devices| {
            devices
                .iter()
                .find(|device| same_device(device, model_b_device))
        })
        .and_then(|device| device["memory_free"].as_u64())
        .unwrap_or(0);
    let free_after_b = model_b_device["memory_free"].as_u64().unwrap_or(0);
    json!({
        "second_model_added_rss_bytes": rss_cost,
        "second_model_device_memory_free_drop_bytes": if free_before_b == 0 || free_after_b == 0 {
            Value::Null
        } else {
            json!(i128::from(free_before_b) - i128::from(free_after_b))
        },
        "device_delta_note": "Model B's resolved device is matched by device id, or by name when no id exists, against the live registry snapshot taken before B loaded. Null means the device could not be matched or the backend did not report live free memory; a positive value is the observed drop.",
    })
}

fn same_device(left: &Value, right: &Value) -> bool {
    match (left["device_id"].as_str(), right["device_id"].as_str()) {
        (Some(left), Some(right)) => left == right,
        (None, None) => left["name"] == right["name"],
        _ => false,
    }
}

fn device(device: &Device) -> Value {
    json!({
        "name": device.name,
        "description": device.description,
        "kind": device.kind,
        "device_type": format!("{:?}", device.device_type),
        "device_id": device.device_id,
        "memory_total": device.memory_total,
        "memory_free": device.memory_free,
        "index": device.index,
    })
}

#[cfg(target_os = "macos")]
fn rss_bytes() -> Result<u64, String> {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .map_err(|error| format!("run ps for RSS: {error}"))?;
    if !output.status.success() {
        return Err(format!("ps RSS exited with {}", output.status));
    }
    let kib: u64 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|error| format!("parse ps RSS output: {error}"))?;
    kib.checked_mul(1024)
        .ok_or_else(|| "ps RSS overflow converting KiB to bytes".into())
}

#[cfg(target_os = "linux")]
fn rss_bytes() -> Result<u64, String> {
    let statm = std::fs::read_to_string("/proc/self/statm")
        .map_err(|error| format!("read /proc/self/statm: {error}"))?;
    let pages: u64 = statm
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "/proc/self/statm has no resident-pages field".to_string())?
        .parse()
        .map_err(|error| format!("parse /proc/self/statm resident pages: {error}"))?;
    let output = Command::new("getconf")
        .arg("PAGESIZE")
        .output()
        .map_err(|error| format!("run getconf PAGESIZE: {error}"))?;
    if !output.status.success() {
        return Err(format!("getconf PAGESIZE exited with {}", output.status));
    }
    let page_size: u64 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|error| format!("parse getconf PAGESIZE output: {error}"))?;
    pages
        .checked_mul(page_size)
        .ok_or_else(|| "/proc/self/statm RSS overflow converting pages to bytes".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rss_bytes() -> Result<u64, String> {
    Err("RSS sampling is implemented only on macOS and Linux".into())
}
