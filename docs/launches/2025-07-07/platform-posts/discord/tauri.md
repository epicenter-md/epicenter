# Discord Tauri Showcase Post

## Post Content

Hey everyone! 👋

Just launched **Whispering** - a free, open-source transcription app built with Tauri + Svelte 5.

**What it does:**
Real-time transcription using your own API keys (OpenAI Whisper, Groq, etc). No subscriptions, no limits.

**Tauri highlights:**
- System tray with global shortcuts
- Secure API key storage
- Lightweight bundle (~22MB on macOS)
- Native audio processing
- Cross-platform (Mac/Win/Linux)

**Cool features:**
- Overlay mode for transcribing over other apps
- Build-time dependency injection for code reuse
- Auto-updater built in

**Architecture highlight:**
Using a services pattern with platform detection at build time, I share ~95% of code between desktop and web versions:
```typescript
window.__TAURI_INTERNALS__ ? desktopImpl() : webImpl()
```
Check out the [services README](https://github.com/epicenter-md/epicenter/tree/main/apps/whispering/src/lib/services) for the full pattern!

GitHub: [link]

Would love feedback from the Tauri community! Happy to answer any implementation questions 🚀