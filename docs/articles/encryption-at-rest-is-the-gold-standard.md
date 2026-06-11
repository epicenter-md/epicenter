# Encryption at Rest Is the Gold Standard

Encryption at rest is the baseline for modern data ownership. It means your data is ciphertext wherever it sits. On your local disk, on a sync server, or in a cloud backup. If someone steals the entire database, they get noise.

## Workspace data is ciphertext by default

In Epicenter, this protection covers every piece of workspace data. Your notes, transcripts, and settings are all encrypted at the CRDT level before they ever leave your application memory. The downstream storage layers only ever see the encrypted result.

```
App code → createEncryptedKvLww → encrypt (XChaCha20-Poly1305) → Y.Doc → IndexedDB / Durable Objects / backups
```

This approach provides defense-in-depth for your most sensitive information. An attacker needs two things to read your data: a full copy of the database and the application secret. Stealing one is hard. Stealing both is significantly harder.

## Metadata remains visible for sync

The encryption uses XChaCha20-Poly1305. Each value is stored as a bare `Uint8Array` with a self-describing binary header: `[formatVersion(1) ‖ keyVersion(1) ‖ nonce(24) ‖ ciphertext ‖ tag(16)]`. The format version is the sole contract for the encryption format. Algorithm, nonce size, tag size, and encoding are all implied by the version.

```
[0x01][keyVer][...24-byte nonce...][...ciphertext + 16-byte Poly1305 tag...]
```

Key names and timestamps remain in plaintext to allow for CRDT conflict resolution. This is a deliberate design choice that mirrors how column names in a database are visible while the row data is encrypted. It allows the system to sync and merge changes without needing to decrypt the values first.

| Strategy | Protects Against | Doesn't Protect Against |
| :--- | :--- | :--- |
| No encryption | Nothing | Network sniffing, database theft, physical access |
| Encryption in transit (TLS) | Network sniffing, man-in-the-middle | Database theft, rogue admins, server compromise |
| Encryption at rest | Database theft, storage snapshots, physical access | Memory scraping on the active client |

## Storage layers see only noise

A raw database dump shows exactly what an attacker would see. Instead of private notes, they find a series of opaque JSON objects.

```sql
SELECT * FROM workspace_data WHERE key = 'note-123';
-- Result: Uint8Array [0x01, keyVer, ...nonce(24), ...ciphertext, ...tag(16)]
```

This ensures a total compromise of the storage infrastructure doesn't lead to a data breach. The storage layer is just a bucket for ciphertext. Application keys stay within the boundary.

## Encryption is part of a larger strategy

- [Why E2E Encryption Keeps Failing](./why-e2e-encryption-keeps-failing.md)
- [Let the Server Handle Encryption](./let-the-server-handle-encryption.md)
- [If You Don't Trust the Server, Become the Server](./if-you-dont-trust-the-server-become-the-server.md)
