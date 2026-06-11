# Recording Materializer. Rust Write Commands

**Date**: 2026-04-15
**Status**: In Progress
**Branch**: feat/whispering-recording-materializer

## Overview

One-way materialization of recording metadata to `.md` files via Rust commands. JS serializes the markdown string, invokes Rust for atomic filesystem writes. The workspace remains the sole source of truth.

## Architecture

```
Workspace (Yjs + IndexedDB)
         │
         │ table.observe(changedIds)
         ▼
┌─────────────────────────────┐
│  JS workspace extension     │
│  serialize row → markdown   │
│  invoke('write_markdown_files') │
│  invoke('bulk_delete_files')    │
└──────────────┬──────────────┘
               │ Tauri IPC
               ▼
┌─────────────────────────────┐
│  Rust command               │
│  atomic write (tmp+rename)  │
│  parallel via rayon         │
└──────────────┬──────────────┘
               ▼
  {appDataDir}/recordings/
  ├── {id}.md    (derived, human-readable)
  └── {id}.webm  (audio, separate concern)
```

## Implementation Plan

### Rust side

- [ ] **1** Rename `markdown_reader.rs` → `markdown.rs` (it now reads AND writes)
- [ ] **2** Add `MarkdownFile` struct and `write_markdown_files` command
- [ ] **3** Update `lib.rs`: module name `markdown_reader` → `markdown`, add `write_markdown_files` to imports and `generate_handler!`

### JS side

- [ ] **4** Replace `client.ts` materializer wiring: drop `createMarkdownMaterializer` + Tauri adapters, add `withWorkspaceExtension` that observes recordings table and invokes Rust commands
- [ ] **5** Delete `tauri-materializer-io.ts` (Rust handles IO now)

### Verify

- [ ] **6** `cargo check` passes for src-tauri
- [ ] **7** LSP diagnostics clean for all changed TS/Svelte files

## Review

_To be filled after implementation._
