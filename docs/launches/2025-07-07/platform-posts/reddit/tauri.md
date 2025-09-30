# Reddit r/tauri Launch Post

## Status: ✅ POSTED

## Posted URL: https://www.reddit.com/r/tauri/comments/1lu2wbo/show_rtauri_svelte_5_tauri_app_with_22mb_bundle/

## Post Type: **Image Post (App Screenshot showing lightweight bundle)**

## Title

Show r/tauri: Svelte 5 + Tauri app with ~22MB bundle, dependency injection, and 97% code sharing between desktop/web

## Post Content

Hey r/tauri!

I wanted to share Whispering, a transcription app I built with Tauri that's been in production for months. The bundle is just 22MB on macOS and I've achieved 97% code sharing between desktop and web versions.

Performance has been stellar. The app starts instantly, idles at near-zero CPU, and uses minimal RAM. That's much better than Electron alternatives that start at 150MB+ just to show a window (Slack on my computer is 490MB).

The killer Tauri feature for me was build-time dependency injection. Instead of maintaining two codebases, I detect the platform and inject the right implementation:

```typescript
// Platform detection at build time
export const ClipboardServiceLive = window.__TAURI_INTERNALS__
  ? createClipboardServiceDesktop() // Tauri APIs
  : createClipboardServiceWeb();     // Browser APIs
```

This pattern (detailed in [services/README.md](https://github.com/epicenter-md/epicenter/tree/main/apps/whispering/src/lib/services)) means I write business logic once. The desktop app gets native performance, system tray, global shortcuts—while the web version uses browser APIs. Same UI, same logic, different runtime. Components don't even know which implementation they're using—it's all swapped at build time, so every component works identically on both platforms.

Some Tauri challenges I solved:
- Smooth auto-updater experience without annoying users
- CI/CD pipeline for multi-platform builds
- Platform-specific fixes (bundling extra packages for Linux)
- macOS audio permissions with Info.plist and Entitlements.plist
- Global shortcuts that actually work across all three OS

The app itself solves a real problem—transcription services charging $30/month for API wrappers. With Whispering, you bring your own API key and pay cents directly to providers. Been using it daily and it's saved me hundreds.

Built with Svelte 5 + Tauri. The combination of Rust backend performance and modern web UI has been fantastic.

GitHub: https://github.com/epicenter-md/epicenter

Happy to dive deep on any Tauri implementation details. What patterns have worked well for your Tauri apps?