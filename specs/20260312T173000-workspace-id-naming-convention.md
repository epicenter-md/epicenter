# Workspace ID Naming Convention

## Problem

Workspace IDs are inconsistent. The documented convention says `epicenter.<app>` but tab-manager uses just `'tab-manager'`. Templates use `'epicenter.whispering'` and `'epicenter.entries'` correctly. We need to standardize and fix the outlier.

## Decision

**All workspace IDs use the format `epicenter.<app-name>`.**

This applies to:
- Platform features (epicenter.whispering, epicenter.entries)
- Personal apps (epicenter.fuji-notes, epicenter.tab-manager)
- Any future workspace

No distinction between "personal" and "platform" at the workspace ID level—that's handled by ownership (user/org scoping in the API layer).

## Impact of Renaming tab-manager

The workspace ID flows into four storage layers:

| Layer | Old Key | New Key |
|---|---|---|
| Y.Doc GUID | `tab-manager` | `epicenter.tab-manager` |
| IndexedDB | DB name `tab-manager` | DB name `epicenter.tab-manager` |
| BroadcastChannel | `yjs:tab-manager` | `yjs:epicenter.tab-manager` |
| Cloudflare DO | `user:{userId}:tab-manager` | `user:{userId}:epicenter.tab-manager` |

**Migration strategy: Clean break.** No data migration. Local-first architecture means the browser extension will create a fresh local DB and sync up to a new (empty) Cloudflare DO. Old DO sits idle at $0 cost.

## Todo

- [x] Rename `id: 'tab-manager'` → `id: 'epicenter.tab-manager'` in `apps/tab-manager/src/lib/workspace.ts`
- [x] Update `apps/tab-manager-markdown/README.md` references to old workspace ID in URLs
- [x] Verify no other code files hardcode `tab-manager` as a workspace ID value
- [ ] (future) Update workspace README convention section if needed

## Files Changed

- `apps/tab-manager/src/lib/workspace.ts` — workspace ID definition
- `apps/tab-manager-markdown/README.md` — documentation URLs

## Review

_To be filled after implementation._
