//! macOS-only native clipboard save/restore for the `write_text` borrow.
//!
//! When `write_text` pastes a transcript at the cursor with clipboard output
//! *off*, it borrows the clipboard: write the transcript, paste, then restore
//! whatever the user had. The cross-platform `tauri-plugin-clipboard-manager`
//! can only carry that snapshot as *text*, so an image, file, or any other
//! representation is silently dropped on restore: the user copies a picture,
//! dictates into a text field, and their picture is gone. That is the bug this
//! module fixes.
//!
//! `NSPasteboard` exposes the clipboard as a list of `NSPasteboardItem`s, each
//! carrying one or more typed representations (a UTI string paired with raw
//! bytes). `snapshot` captures every item's every type/data pair into owned
//! Rust data; `restore` clears the pasteboard and re-adds items from that
//! capture. Round-tripping the bytes verbatim preserves full fidelity for the
//! representations the system materializes eagerly.
//!
//! This is the app's first direct Objective-C binding (objc2). The rest of the
//! macOS interop uses C-API crates (core-graphics, accessibility-sys) and
//! tauri-nspanel, so there was no objc2 in the tree before this.
//!
//! Threading: `NSPasteboard` is documented thread-safe, and the existing
//! `tauri-plugin-clipboard-manager` calls (arboard, which also drives
//! `NSPasteboard` under the hood) already run from this same tokio command
//! context, so these native calls touch the pasteboard from no thread the app
//! wasn't already using. Each entry point wraps its work in an
//! `autoreleasepool` because a tokio worker thread has no ambient pool, so the
//! transiently-autoreleased temporaries the AppKit methods return would
//! otherwise leak until the thread exits.
//!
//! Out of scope (documented, not handled): promised/lazy pasteboard data
//! (a type declared with a data *provider* rather than materialized bytes) is
//! skipped because `dataForType:` returns nothing for it without invoking the
//! originating app's provider callback.

use objc2::rc::autoreleasepool;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSData, NSString};

/// The clipboard-history "ignore me" marker. Managers that honor the
/// convention (see nspasteboard.org) skip any pasteboard contents carrying this
/// type, which keeps the transient transcript out of their history. It is a
/// *convention*, not an OS-enforced rule: coverage is per-manager and unverified
/// here (Raycast, in particular, is unconfirmed), so it is strictly best-effort.
const CONCEALED_TYPE: &str = "org.nspasteboard.ConcealedType";

/// One captured pasteboard item: each declared type's UTI paired with its raw
/// bytes. Owned plain data (not retained Objective-C objects) so the snapshot
/// is `Send` and can be held across the paste-consume `await` in `write_text`.
struct CapturedItem {
    types: Vec<(String, Vec<u8>)>,
}

/// A full-fidelity capture of the clipboard at a point in time. Opaque; produce
/// it with [`snapshot`] and hand it back to [`restore`].
pub struct ClipboardSnapshot {
    items: Vec<CapturedItem>,
}

/// Capture every item and every materialized representation currently on the
/// general pasteboard. An empty clipboard yields an empty snapshot, which
/// [`restore`] faithfully reproduces as an empty clipboard.
pub fn snapshot() -> ClipboardSnapshot {
    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        let Some(items) = pasteboard.pasteboardItems() else {
            return ClipboardSnapshot { items: Vec::new() };
        };

        let captured = items
            .iter()
            .map(|item| {
                let types = item
                    .types()
                    .iter()
                    .filter_map(|ty| {
                        // A type with no materialized bytes (a promised/lazy
                        // provider) returns `None` here; skip it rather than
                        // invoking the originating app's provider callback.
                        let data = item.dataForType(&ty)?;
                        Some((ty.to_string(), data.to_vec()))
                    })
                    .collect();
                CapturedItem { types }
            })
            .collect();

        ClipboardSnapshot { items: captured }
    })
}

/// Clear the general pasteboard and re-add the captured items verbatim. Each
/// recreated `NSPasteboardItem` carries the same type/bytes pairs the snapshot
/// recorded, so a restored image or file is byte-identical to the original.
pub fn restore(snapshot: &ClipboardSnapshot) {
    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();

        let items: Vec<_> = snapshot
            .items
            .iter()
            .map(|captured| {
                let item = NSPasteboardItem::new();
                for (uti, bytes) in &captured.types {
                    let data = NSData::with_bytes(bytes);
                    let ty = NSString::from_str(uti);
                    item.setData_forType(&data, &ty);
                }
                ProtocolObject::<dyn NSPasteboardWriting>::from_retained(item)
            })
            .collect();

        let objects = NSArray::from_retained_slice(&items);
        pasteboard.writeObjects(&objects);
    })
}

/// Replace the clipboard with the transcript, marked concealed so honoring
/// clipboard-history managers skip it (see [`CONCEALED_TYPE`]). Returns whether
/// the transcript string itself was written; the concealed marker is
/// best-effort and its result is ignored.
pub fn write_concealed(text: &str) -> bool {
    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();

        // SAFETY: reading an AppKit `extern "C"` string constant; always valid
        // once AppKit is loaded, which it is for this GUI process.
        let string_type = unsafe { NSPasteboardTypeString };
        let wrote = pasteboard.setString_forType(&NSString::from_str(text), string_type);

        let concealed_type = NSString::from_str(CONCEALED_TYPE);
        pasteboard.setString_forType(&NSString::from_str(""), &concealed_type);

        wrote
    })
}
