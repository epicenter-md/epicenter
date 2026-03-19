# You Don't Need Global Shortcuts for In-App Hotkeys

If you want keyboard shortcuts inside your Tauri app, the most idiomatic approach is still `window.addEventListener('keydown', ...)`. Same as any web app. Tauri's global shortcut plugin exists for a specific, narrower use case: shortcuts that fire regardless of whether your app is focused, minimized, or even if another application is active.

Most people reach for `tauri-plugin-global-shortcut` the moment they hear "keyboard shortcuts in Tauri." Don't. You probably just need a regular event listener.

## Global Shortcuts Are OS-Level Hooks

When you register a global shortcut, Tauri talks directly to the operating system. macOS, Windows, and Linux each have their own hotkey registration APIs, and the plugin abstracts over all of them. The shortcut fires everywhere—your app could be minimized to the system tray and it still triggers.

```typescript
import { register } from '@tauri-apps/plugin-global-shortcut';

// This fires even when you're in Chrome, VS Code, anywhere
await register('CommandOrControl+Shift+Space', (event) => {
  if (event.state === 'Pressed') {
    startRecording();
  }
});
```

That's the entire point. It's a system-wide hook. The OS intercepts the key combination before any focused application sees it.

## Regular Event Listeners Work in Tauri

Tauri renders your frontend in a webview. The webview handles keyboard events like any browser. So standard DOM APIs work exactly as you'd expect:

```typescript
// This fires only when your app window is focused
window.addEventListener('keydown', (e) => {
  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    saveDocument();
  }
});
```

No plugin needed. No Cargo dependency. No permission configuration. The webview already gives you this for free.

## When to Use Which

Reach for global shortcuts when the user isn't looking at your app. Push-to-talk while in a game. Media controls while browsing. Quick capture from any context. Whispering uses a global shortcut for exactly this—you press the hotkey in whatever app you're using and it starts recording.

Stick with `addEventListener` for everything else. Navigation, editor commands, form shortcuts, panel toggles—anything where the user is already interacting with your window. It's simpler, requires no native plugin, and behaves identically to how you'd do it in a web app.

The global shortcut plugin also comes with overhead you don't want unless you need it: OS-level registration that can conflict with other apps' shortcuts, platform-specific permission requirements, and cleanup logic to unregister on exit. Regular event listeners have none of these concerns.
