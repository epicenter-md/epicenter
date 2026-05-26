# Project Brief

## Overview
Fork of EpicenterHQ/epicenter focused on the Whispering desktop app -- a speech-to-text tool that records audio, transcribes via Groq cloud API, and pastes text at the cursor. This fork adds Linux-specific fixes.

## Goals
- Fix clipboard paste in terminal emulators on Linux
- Keep Tauri plugin versions in sync to prevent silent failures
- Maintain compatibility with upstream for easy syncing

## Scope
- Whispering app (`apps/whispering/`) only -- other monorepo packages are unchanged
- Linux-specific fixes in the Rust backend (`src-tauri/`)
- No frontend/UI changes

## Target Users / Audience
Linux users who use Whispering for voice dictation in terminal environments.

## Success Criteria
- Transcribed text pastes correctly in both terminal and non-terminal apps
- Groq cloud transcription works without errors
- Upstream PR merged or fork stays in sync with upstream releases
