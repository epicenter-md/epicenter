# Reddit r/rust Launch Post

## Status: ✅ POSTED

## Posted URL: https://www.reddit.com/r/rust/comments/1lu3aj3/built_a_desktop_transcription_app_with_tauri_and/

## Title

Built a desktop transcription app with Tauri and Rust/Wry's performance has been amazing

## Post Content

Hey Rustaceans!

I built a transcription app with Tauri and the Rust performance benefits have been incredible. I wish all Electron apps were built with this framework.

What impressed me most about Tauri: the final bundle is just 22MB on macOS and starts instantly. Near-zero idle CPU. Compare that to Electron apps that start at 150MB+ just to show "Hello World". Slack on my machine is over 490MB, which is crazy.

The beauty of Tauri is that many common functions (like `fs`, `fetch`, `shell`) are implemented in Rust and exposed as JavaScript APIs. It feels almost Node-like—the functions you'd rely on in server-side Node have Rust equivalents that you can call directly from JavaScript. This gives you native performance without needing to write and register your own Tauri commands and invoke them from the frontend for every basic operation. But I still had to write quite a bit of my own Rust for platform-specific features, which has been really fun. Organizing the bridge between TypeScript and Rust has been an interesting challenge.

For example, I needed to handle macOS accessibility permissions. While Tauri provides most of what you need, some features require custom Rust code:

```rust
#[tauri::command]
pub fn is_macos_accessibility_enabled(ask_if_not_allowed: bool) -> Result<bool, &'static str> {
    let options = create_options_dictionary(ask_if_not_allowed)?;
    let is_allowed = unsafe { AXIsProcessTrustedWithOptions(options) };
    release_options_dictionary(options);
    Ok(is_allowed)
}
```

The `#[tauri::command]` macro makes it seamless to call this from TypeScript. The full implementation ([accessibility.rs](https://github.com/epicenter-md/epicenter/blob/main/apps/whispering/src-tauri/src/accessibility.rs)) can be found here.

Tauri's IPC is blazing fast—the Rust backend handles server-side-like operations, while the frontend stays static and lightweight. We achieved 97% code sharing between desktop and web by using dependency injection at build time.

GitHub: https://github.com/epicenter-md/epicenter

Happy to dive into implementation details or discuss Tauri patterns. Anyone else building desktop apps with Rust?