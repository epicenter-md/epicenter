# Why Epicenter Doesn't Encrypt Without Authentication

Epicenter encrypts your workspace data with XChaCha20-Poly1305 via `@noble/ciphers`. But only when you're signed in. Before authentication, your data sits as plaintext in IndexedDB. This is deliberate.

The obvious question: why not always encrypt? Generate a random key on workspace creation, encrypt everything from the start, then swap to the real user-derived key when you sign in. No plaintext ever touches storage.

We considered this. It's not worth it.

## Encryption without identity is a locked diary with the key taped to the cover

The value of encryption comes from who holds the key, not from the act of encrypting. Epicenter's key hierarchy ties encryption to your identity: the server derives a per-user key via HKDF from a secret only it knows, the client derives a per-workspace key from that, and XChaCha20-Poly1305 does the rest. When you sign out, the browser runtime reloads and drops the in-memory keyring. Nobody with only the local ciphertext can read the data without your credentials. That's meaningful protection.

A random local key has plaintext of these properties. It exists in the same JavaScript heap as the data it protects. Any attacker who can read IndexedDB through the browser's developer tools, a malicious extension, or a forensic disk image can also read the key from memory or from wherever you stored it. The encryption algorithm is unbreakable from ciphertext alone, but the key is right there next to the ciphertext.

```
User-derived key (signed in):
  Server secret → HKDF("user:{id}") → per-user key → HKDF("workspace:{id}") → workspace key
  Sign out -> runtime reload drops keyring -> local ciphertext stays encrypted

Random local key (not signed in):
  crypto.getRandomValues(32) → stored in sessionStorage → encrypt everything
  Attacker reads IndexedDB → also reads sessionStorage → decrypts everything
```

The first key derives its strength from a secret the attacker doesn't have. The second key sits in the same browser profile as the data.

## The storage lifespan problem

Where do you store a random local key? The cleanest option is `sessionStorage`: it dies when the tab closes, which is the right lifetime for an ephemeral key. But IndexedDB data survives tab close. Encrypt with a key stored in `sessionStorage`, close the tab, reopen it, and your data is gone. The ciphertext is still in IndexedDB, encrypted with a key that no longer exists.

For a tab manager capturing ephemeral state, you could argue that's acceptable. Just destroy and recreate the workspace on each session. But Epicenter workspaces store bookmarks, chat messages, transcripts, and settings. Users expect that data to survive a tab close. Encrypting it with a key that doesn't survive is worse than not encrypting at all.

The alternative is storing the key in IndexedDB alongside the data. Now the key persists across sessions, but an attacker who can read IndexedDB reads both the ciphertext and the key in the same storage API call. You've added the overhead of XChaCha20-Poly1305 to every read and write for zero security gain.

## Browsers already encrypt IndexedDB on disk

The narrow threat a local key addresses, passive inspection of IndexedDB at rest on disk without JavaScript execution, is already partially covered by the operating system. Chrome encrypts its storage using the macOS Keychain on Apple devices and DPAPI on Windows, both scoped to the logged-in OS user session. Chrome extensions get per-extension storage isolation; other extensions cannot access your IndexedDB.

The residual threat is forensic analysis of an unlocked machine's raw disk, bypassing OS-level encryption. That's a real scenario for high-value targets, but it's not the threat model for a workspace app. And if the attacker has physical access to an unlocked machine, they can also open the browser and read the data through the UI.

## The complexity cost is real

Adding a local key means two key sources: the random one for unauthenticated state and the user-derived one for authenticated state. The `createEncryptedYkvLww` wrapper would need to handle the transition. Decrypt everything with the local key, re-encrypt with the user-derived key, fire synthetic change events for any values that changed. That transition already exists as `activateEncryption()`, but using it for key migration introduces new concerns.

What happens if the user signs in while a write is in progress? The re-encryption loop iterates every entry in the CRDT, calling `encryptValue` on each one. A concurrent `set()` could write with the old key after re-encryption has already started. The generation counter in the key manager handles this for the normal activateEncryption flow, but adding a second key source doubles the state space for race conditions.

The key manager would also need to know about both key types. Currently it has a single responsibility: bridge the async gap between the auth session and the workspace client. Adding local key generation, storage, and migration turns a focused component into a key lifecycle orchestrator.

| Strategy | Protects against | Doesn't protect against | Complexity |
|:---|:---|:---|:---|
| No encryption (current unauthenticated state) | Nothing | Everything | None |
| Random local key in sessionStorage | Passive disk forensics (partial) | JS execution access, tab close destroys key | High. Two key sources, migration, race conditions |
| Random local key in IndexedDB | Nothing (key adjacent to data) | Everything | High. Same complexity, zero security gain |
| User-derived key (current authenticated state) | Database breach, storage compromise, disk forensics | Memory scraping on encrypted client | Already implemented |

## The design is honest about what it does

Epicenter's `createEncryptedYkvLww` starts as a zero-overhead passthrough when no key is present. Reads and writes go straight through to the underlying `YKeyValueLww` without touching any crypto code. When the user authenticates and `activateEncryption()` delivers a real key, the wrapper encrypts all existing entries in place and transitions to encrypted mode. Every subsequent write is ciphertext in the CRDT, ciphertext in IndexedDB, ciphertext on the sync server.

This design doesn't pretend to protect data it can't protect. Before authentication, there's no key with any security property worth having. After authentication, the key is derived from a server secret that the attacker doesn't have access to. The transition is sharp: plaintext, then real encryption. No middle ground that costs complexity and delivers nothing.

If you don't trust the server to hold the key, the answer isn't a local key that sits next to the data. The answer is self-hosting. Running the same server on your own infrastructure, where server-managed encryption becomes zero-knowledge because you control the machine. Same code, same HKDF hierarchy, same XChaCha20-Poly1305. Different trust boundary.

## Related

- [Let the Server Handle Encryption](./let-the-server-handle-encryption.md): the broader argument for server-managed keys
- [If You Don't Trust the Server, Become the Server](./if-you-dont-trust-the-server-become-the-server.md): self-hosting as the clean answer to zero-knowledge
- [Encryption at Rest Is the Gold Standard](./encryption-at-rest-is-the-gold-standard.md): how Epicenter encrypts sensitive data at rest
