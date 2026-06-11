# Encryption Documentation Refresh

**Date**: 2026-03-13
**Status**: Draft

> **Note (2026-03-13)**: The `alg` field was later removed from `EncryptedBlob`. References to `{ v: 1, alg: 'A256GCM', ct, iv }` below are historical. See `specs/20260313T180000-encrypted-blob-format-simplification.md`.
> **Note (2026-03-13)**: Blob format further simplified to 2-field `{ v: 1, ct }` where ct = base64(nonce || ciphertext || tag). See `specs/20260313T202000-encrypted-blob-pack-nonce.md`.
> **Note (2026-03-14)**: The `{ v: 1, ct }` object wrapper has been replaced with a bare `Uint8Array` with self-describing binary header. See `specs/20260314T230000-bare-uint8array-encrypted-blob.md`.

## Overview

The encrypted KVLWW implementation landed. The docs and READMEs still describe encryption in abstract terms ("server-managed encryption at rest") without mentioning what actually happens: encryption inside the CRDT data structure, one code path where the key source is the only variable, and real zero-knowledge for self-hosted users.

This spec covers updating all encryption-related documentation to reflect the implementation and frame it honestly for a technical (HN-adjacent) audience.

## What Changed Since the Docs Were Written

1. Encryption happens inside `YKeyValueLww` via `createEncryptedKvLww`: not as a middleware or at-rest wrapper
2. `@noble/ciphers` provides synchronous AES-256-GCM (not Web Crypto async)
3. Self-hosted users derive keys from their password via PBKDF2. Real zero-knowledge, same code path
4. The encrypted blob format is versioned (`{ v: 1, ct }`)
5. Mixed-mode detection handles plaintext→encrypted migration transparently
6. One primitive, one code path. Key source is the only variable between cloud and self-hosted.

## The Narrative (Consistent Across All Docs)

**Technical hook**: Encryption at the CRDT layer. Values are AES-256-GCM ciphertext before they enter the Y.Doc. Every storage layer downstream. IndexedDB, Durable Objects, backups. Sees ciphertext automatically.

**Honest tradeoff**: Cloud users trust the server. The server holds the key. But a DB dump alone is useless. You need the application secret too. Defense in depth, not zero trust.

**Escape hatch**: Self-host and the server never sees your key. Same code, same `createEncryptedKvLww`, key derives from your password via PBKDF2. That's real zero-knowledge.

## Files to Update

### 1. `README.md`: `## Encryption` section (rewrite)

**Current problem**: Generic "server-managed encryption at rest." Doesn't mention the CRDT layer, doesn't explain what defense-in-depth actually means here, reads like a privacy policy.

**New version should**:
- Lead with the technical fact: encryption inside the CRDT, not around it
- Include a compact ASCII diagram showing where ciphertext lives
- Be honest about cloud mode (server holds key, can decrypt)
- Pitch the self-hosted escape hatch as the headline for the security-conscious
- Keep the "Further reading" links

### 2. `apps/api/README.md`: `## Encryption and trust model` section (refresh)

**Current problem**: Already decent but says "encrypted at rest with AES-256-GCM" without explaining where the encryption boundary sits. Doesn't mention the CRDT layer or `@noble/ciphers`.

**New version should**:
- Add that encryption is at the CRDT data structure level (inside `YKeyValueLww`)
- Mention `@noble/ciphers`: synchronous, Cure53-audited, one code path
- Keep the deployment table (it's good)
- Keep the "Why not zero-knowledge?" section (it's good)
- Add brief note about what Durable Objects see vs what they can't read

### 3. `docs/articles/encryption-at-rest-is-the-gold-standard.md` (significant rewrite)

**Current problem**: References "API key vault" which was superseded months ago. Describes a generic encryption-at-rest concept without explaining the CRDT-level implementation. The diagram is about API keys specifically, not workspace data generally.

**New version should**:
- Update the opening to explain CRDT-level encryption for all workspace data
- Replace the API key vault diagram with one showing the `createEncryptedKvLww` → Y.Doc → storage layer flow
- Keep the comparison table (no encryption vs TLS vs at rest): it's useful
- Add the defense-in-depth framing: DB dump alone = noise, need the application secret
- Drop all API key vault references
- Add a "What this looks like in practice" section with the encrypted blob format

### 4. `docs/articles/let-the-server-handle-encryption.md` (add implementation section)

**Current problem**: Strong argument, but entirely abstract. Doesn't mention how Epicenter actually implements this now.

**Changes**:
- Add a short section before "Related" showing how Epicenter implements this concretely
- One primitive (`createEncryptedKvLww`), key source is the only variable
- Brief code-like illustration of cloud vs self-hosted key paths
- Keep everything else. The argument is solid

### 5. `docs/articles/if-you-dont-trust-the-server-become-the-server.md` (add concrete detail)

**Current problem**: Abstract argument about self-hosting. Doesn't show that the self-hosted zero-knowledge story is literally the same code with a different key source.

**Changes**:
- Add concrete detail to the "Server-managed encryption becomes zero-knowledge" section
- Show the key source table: cloud = server-derived, self-hosted = PBKDF2 from password
- Mention that the encryption code is identical. Not "similar" or "compatible," identical
- Keep everything else

### 6. `docs/articles/why-e2e-encryption-keeps-failing.md`: no changes

Already a general argument. Implementation details don't belong here.

## Implementation Plan

- [x] **1.** Rewrite `README.md` `## Encryption` section
- [x] **2.** Refresh `apps/api/README.md` `## Encryption and trust model` section
  > **Note**: Agent appended new content but didn't remove old. Fixed by deleting duplicate lines 55-77 manually.
- [x] **3.** Rewrite `docs/articles/encryption-at-rest-is-the-gold-standard.md`
- [x] **4.** Add implementation section to `docs/articles/let-the-server-handle-encryption.md`
- [x] **5.** Add concrete detail to `docs/articles/if-you-dont-trust-the-server-become-the-server.md`

## Review

**Completed**: 2026-03-13
**Status**: Implemented

### Summary

Updated all encryption documentation to reflect the `createEncryptedKvLww` implementation. The narrative across all docs is now consistent: encryption at the CRDT layer, honest about cloud mode (server holds key), self-hosted = zero-knowledge with the same code path.

### Changes by file

1. **README.md**: Rewrote Encryption section. Leads with CRDT-level encryption, compact flow diagram, defense-in-depth framing, self-host escape hatch.
2. **apps/api/README.md**: Added CRDT-layer detail, `@noble/ciphers` mention, encrypted blob format. Fixed duplicate content from agent error.
3. **encryption-at-rest-is-the-gold-standard.md**: Full rewrite. Removed stale API key vault references. New content covers all workspace data with updated diagrams and defense-in-depth framing.
4. **let-the-server-handle-encryption.md**: Added "One primitive, one code path" section with `createEncryptedKvLww` code example and key-source table.
5. **if-you-dont-trust-the-server-become-the-server.md**: Added concrete `createEncryptedKvLww` detail to zero-knowledge section, showing identical code with PBKDF2 key derivation.

### Deviations from spec

- apps/api/README.md agent duplicated old content instead of replacing. Fixed manually by removing lines 55-77.
