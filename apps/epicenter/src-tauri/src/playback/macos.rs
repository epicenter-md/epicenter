//! Recording-scoped output ducking through macOS's public CoreAudio API.

use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_foundation_sys::string::{
    kCFStringEncodingUTF8, CFStringGetCString, CFStringGetLength, CFStringRef,
};
use std::ffi::{c_void, CStr};
use std::os::raw::c_char;
use std::ptr;
use std::thread;
use std::time::Duration;

type OSStatus = i32;
type AudioObjectID = u32;
type AudioObjectPropertySelector = u32;
type AudioObjectPropertyScope = u32;
type AudioObjectPropertyElement = u32;

#[repr(C)]
struct AudioObjectPropertyAddress {
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
    element: AudioObjectPropertyElement,
}

const SYSTEM_OBJECT: AudioObjectID = 1;
const UNKNOWN_OBJECT: AudioObjectID = 0;
const SCOPE_GLOBAL: AudioObjectPropertyScope = 0x676c_6f62; // 'glob'
const SCOPE_OUTPUT: AudioObjectPropertyScope = 0x6f75_7470; // 'outp'
const ELEMENT_MAIN: AudioObjectPropertyElement = 0;
const DEFAULT_OUTPUT_DEVICE: AudioObjectPropertySelector = 0x644f_7574; // 'dOut'
const DEVICE_UID: AudioObjectPropertySelector = 0x7569_6420; // 'uid '
const VOLUME_SCALAR: AudioObjectPropertySelector = 0x766f_6c6d; // 'volm'
const DUCK_TARGET: f32 = 0.2;
const VOLUME_EPSILON: f32 = 0.001;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectHasProperty(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
    ) -> u8;
    fn AudioObjectIsPropertySettable(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        out_is_settable: *mut u8,
    ) -> OSStatus;
    fn AudioObjectGetPropertyData(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        io_data_size: *mut u32,
        out_data: *mut c_void,
    ) -> OSStatus;
    fn AudioObjectSetPropertyData(
        object_id: AudioObjectID,
        address: *const AudioObjectPropertyAddress,
        qualifier_data_size: u32,
        qualifier_data: *const c_void,
        data_size: u32,
        data: *const c_void,
    ) -> OSStatus;
}

#[derive(Debug)]
pub(super) struct Effect {
    snapshot: Option<Snapshot>,
}

#[derive(Debug)]
struct Snapshot {
    device: AudioObjectID,
    device_uid: String,
    controls: Vec<ControlSnapshot>,
}

#[derive(Debug)]
struct ControlSnapshot {
    element: AudioObjectPropertyElement,
    original: f32,
    applied: f32,
}

/// Duck the current default output device without ever increasing its volume.
pub(super) async fn suppress() -> Result<Effect, String> {
    let Some(device) = default_output_device()? else {
        return Ok(Effect { snapshot: None });
    };
    let Some(device_uid) = device_uid(device)? else {
        return Ok(Effect { snapshot: None });
    };

    let elements = if is_settable_volume(device, ELEMENT_MAIN) {
        vec![ELEMENT_MAIN]
    } else {
        // Devices without a master control commonly expose independent stereo
        // controls. Require both so ducking cannot skew the channel balance.
        let stereo = [1, 2];
        if stereo
            .iter()
            .all(|&element| is_settable_volume(device, element))
        {
            stereo.to_vec()
        } else {
            return Ok(Effect { snapshot: None });
        }
    };

    let mut controls = Vec::new();
    for element in elements {
        let original = read_volume(device, element)?;
        if original <= DUCK_TARGET + VOLUME_EPSILON {
            continue;
        }
        if let Err(error) = set_volume(device, element, DUCK_TARGET) {
            restore_controls(device, &controls);
            return Err(error);
        }
        let applied = read_applied_volume(device, element, original);
        controls.push(ControlSnapshot {
            element,
            original,
            applied,
        });
    }

    Ok(Effect {
        snapshot: (!controls.is_empty()).then_some(Snapshot {
            device,
            device_uid,
            controls,
        }),
    })
}

/// Restore only volume values that still equal the values this effect applied.
pub(super) async fn restore(effect: Effect) -> Result<(), String> {
    let Some(snapshot) = effect.snapshot else {
        return Ok(());
    };
    let current_default = default_output_device()?;
    if current_default != Some(snapshot.device)
        || device_uid(snapshot.device)?.as_deref() != Some(snapshot.device_uid.as_str())
    {
        return Ok(());
    }

    let mut failures = Vec::new();
    for control in snapshot.controls {
        match read_volume(snapshot.device, control.element) {
            Ok(current) if approximately_equal(current, control.applied) => {
                if let Err(error) = set_volume(snapshot.device, control.element, control.original) {
                    failures.push(error);
                }
            }
            Ok(_) => {}
            Err(error) => failures.push(error),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn default_output_device() -> Result<Option<AudioObjectID>, String> {
    let address = address(DEFAULT_OUTPUT_DEVICE, SCOPE_GLOBAL, ELEMENT_MAIN);
    let mut device = UNKNOWN_OBJECT;
    get_property(SYSTEM_OBJECT, &address, &mut device)?;
    Ok((device != UNKNOWN_OBJECT).then_some(device))
}

fn device_uid(device: AudioObjectID) -> Result<Option<String>, String> {
    let address = address(DEVICE_UID, SCOPE_GLOBAL, ELEMENT_MAIN);
    if !has_property(device, &address) {
        return Ok(None);
    }
    let mut value: CFStringRef = ptr::null();
    get_property(device, &address, &mut value)?;
    if value.is_null() {
        return Ok(None);
    }
    let uid = cf_string_to_string(value);
    // SAFETY: CoreAudio returns an owned CFString for the device UID property.
    unsafe { CFRelease(value as CFTypeRef) };
    Ok(uid)
}

fn is_settable_volume(device: AudioObjectID, element: AudioObjectPropertyElement) -> bool {
    let address = volume_address(element);
    if !has_property(device, &address) {
        return false;
    }
    let mut settable = 0;
    // SAFETY: all pointers refer to initialized values for the duration of the call.
    unsafe { AudioObjectIsPropertySettable(device, &address, &mut settable) == 0 && settable != 0 }
}

fn read_volume(device: AudioObjectID, element: AudioObjectPropertyElement) -> Result<f32, String> {
    let mut volume = 0.0;
    get_property(device, &volume_address(element), &mut volume)?;
    Ok(volume)
}

fn set_volume(
    device: AudioObjectID,
    element: AudioObjectPropertyElement,
    volume: f32,
) -> Result<(), String> {
    let address = volume_address(element);
    // SAFETY: `volume` has the Float32 representation required by the property.
    let status = unsafe {
        AudioObjectSetPropertyData(
            device,
            &address,
            0,
            ptr::null(),
            size_of::<f32>() as u32,
            ptr::addr_of!(volume).cast::<c_void>(),
        )
    };
    status_result(status, "set output volume")
}

fn read_applied_volume(
    device: AudioObjectID,
    element: AudioObjectPropertyElement,
    original: f32,
) -> f32 {
    // CoreAudio property writes may settle asynchronously. Capture the actual
    // hardware value because scalar controls can quantize the requested value.
    for _ in 0..20 {
        if let Ok(current) = read_volume(device, element) {
            if !approximately_equal(current, original) {
                return current;
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
    read_volume(device, element).unwrap_or(DUCK_TARGET)
}

fn restore_controls(device: AudioObjectID, controls: &[ControlSnapshot]) {
    for control in controls {
        if read_volume(device, control.element)
            .is_ok_and(|current| approximately_equal(current, control.applied))
        {
            let _ = set_volume(device, control.element, control.original);
        }
    }
}

fn get_property<T>(
    object: AudioObjectID,
    address: &AudioObjectPropertyAddress,
    value: &mut T,
) -> Result<(), String> {
    let mut size = size_of::<T>() as u32;
    // SAFETY: `value` points to `size` writable bytes of the property's declared type.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            address,
            0,
            ptr::null(),
            &mut size,
            ptr::from_mut(value).cast::<c_void>(),
        )
    };
    status_result(status, "read CoreAudio property")
}

fn has_property(object: AudioObjectID, address: &AudioObjectPropertyAddress) -> bool {
    // SAFETY: `address` remains valid for the duration of the call.
    unsafe { AudioObjectHasProperty(object, address) != 0 }
}

fn status_result(status: OSStatus, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation} failed with OSStatus {status}"))
    }
}

fn volume_address(element: AudioObjectPropertyElement) -> AudioObjectPropertyAddress {
    address(VOLUME_SCALAR, SCOPE_OUTPUT, element)
}

const fn address(
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
    element: AudioObjectPropertyElement,
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        selector,
        scope,
        element,
    }
}

fn approximately_equal(left: f32, right: f32) -> bool {
    (left - right).abs() <= VOLUME_EPSILON
}

fn cf_string_to_string(value: CFStringRef) -> Option<String> {
    // SAFETY: the caller supplies a valid retained CFStringRef.
    unsafe {
        let length = CFStringGetLength(value);
        let capacity = length * 3 + 1;
        let mut buffer = vec![0 as c_char; capacity as usize];
        if CFStringGetCString(value, buffer.as_mut_ptr(), capacity, kCFStringEncodingUTF8) == 0 {
            return None;
        }
        Some(
            CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }
}
