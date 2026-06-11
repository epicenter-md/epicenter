# Let the Server Handle Encryption

A [comment on Hacker News](https://news.ycombinator.com/item?id=47346261) recently put into words something I've been thinking about for a while. In a thread about a decentralized social networking project built on X25519 keypairs and client-side cryptography, a user wrote:

> I want something where it's secured by a username and password, that I give to a server I am registered with. And that server handles the encryption business. If the server rotates keys, that's for the admin to figure out.

That's the position I've arrived at building Epicenter. End-to-end encryption is a real technical achievement. For most products, it's the wrong tradeoff.

## E2E encryption breaks every useful feature

End-to-end encryption means the server can't read your data. That sounds like an unqualified win until you list what it actually costs.

Password recovery is the first casualty. Forget your password in a zero-knowledge system and your data is gone forever. No reset flow saves you because the server literally cannot decrypt anything without a key derived from your password. Signal handles this by storing almost nothing server-side. Messages live on your device, not theirs. That works for chat. It doesn't work for a workspace with thousands of documents, transcripts, and settings that need to sync across devices.

Full-text search is the second. The server can't index what it can't decrypt. Client-side search on a large dataset is slow at best, impossible offline. Proton has spent years building encrypted search; it's still noticeably worse than Gmail's.

AI features are the third. If the server can't read your notes, it can't summarize them, search them semantically, or feed them as context to a language model. You either decrypt client-side and send plaintext to a third-party API. Defeating the purpose. Or you wait for practical encrypted inference, which doesn't exist yet.

Device migration is the fourth. Buy a new laptop and your data doesn't follow you unless you stored your encryption key somewhere recoverable. A piece of paper? Another password manager? A "recovery code" that's just a key with extra steps?

Each of these has workarounds. Every workaround is worse than just letting the server hold the key.

## E2E protects against the wrong threat

Here's the part nobody wants to say out loud: for most consumer software, end-to-end encryption guards against a threat that rarely materializes while ignoring the one that does.

You install an app. You give it filesystem access, clipboard access, microphone access. The app reads your data before encrypting it. If the developer ships a malicious update, E2E doesn't help. The app already saw your plaintext. What E2E actually protects against is a rogue server admin inspecting your data at rest. That's a real concern, but the app developer IS the server admin, or controls what the server runs. You trust them either way; E2E just moves where in the pipeline you extend that trust.

PGP is the cautionary tale. Thirty years of existence. Technically sound encryption. Virtually nobody uses it for email. Key management. Generating, exchanging, revoking, the web of trust. Killed adoption so thoroughly that even the cryptography community stopped pushing it for consumers.

Signal is the exception, and it works precisely because messaging is one-dimensional: text in, text out. The server is a relay that doesn't need to process your data. Most apps aren't relays.

## Even we don't follow our own ideals

The most interesting part of that HN thread wasn't the encryption debate. It was a commenter pointing out that the people advocating for decentralized, encrypted-by-default systems are posting on centralized Hacker News, hosting code on centralized GitHub, and chatting on centralized Discord. The decentralized social networking project itself was hosted on GitHub.

Technical people who could self-host choose not to. Not out of laziness. Self-hosting is its own kind of prison. You trade the risk of a centralized service misusing your data for the certainty of maintaining servers, updating packages, rotating certificates, debugging DNS at 2am. Most of us do the math and pick convenience.

If technical people consistently make that tradeoff for themselves, building consumer products that demand even more friction from non-technical users isn't principled. It's setting those products up to fail.

## Server-managed encryption solves the actual problem

The realistic threats for most users are database breaches and storage-layer compromises. An attacker dumps a database and your data is in the dump. Server-managed encryption. Where the server holds a per-user key, encrypts data at rest, and decrypts on authenticated requests. Handles this cleanly.

```
User logs in → server validates credentials → retrieves per-user key → decrypts data → sends over TLS

Attacker dumps database → encrypted blobs, no keys in the dump → useless
```

The user never sees a key, manages a key, or loses a key. Password reset works. Search works. AI features work. New device setup is login and sync.

The tradeoff is explicit: the server can read your data. For a product that needs to run AI completions against your notes, index your documents for search, and let you reset your password without losing everything. That's not a concession. It's the design.

## If you don't trust the server, become the server

This is what makes the whole tradeoff clean. For users who genuinely need the server to be unable to read their data, the answer isn't bolting client-side cryptography onto a hosted product. The answer is self-hosting.

When you self-host, server-managed encryption IS zero-knowledge. The encryption key sits on a machine you control. Nobody else has access. You get every benefit of server-managed encryption: search, AI, password recovery, with the security properties of zero-knowledge. No key ceremony. No recovery codes. Just a server that happens to be yours.

GitLab, Outline, and Mattermost all work this way. Enterprise customers who need total control deploy the product on their own infrastructure. The self-hosted deployment is the trust boundary. No special encryption scheme embedded in the app.

| | Zero-knowledge E2E | Server-managed keys |
|---|---|---|
| Protects against | Rogue server admin | Database breach |
| Forgot password | Data gone forever | Normal reset |
| Search, AI, indexing | Can't | Works |
| New device | Need key or recovery code | Login and sync |
| Complexity | High | Low |
| Want zero-knowledge? | Built in | Self-host |

The single advantage of zero-knowledge. Protection from the server operator. Disappears when self-hosting lets you become the server operator. For everything else, let the server handle encryption.

## One primitive, one code path

Epicenter implements this philosophy by wrapping its core storage primitive in a single encryption layer. Instead of building separate "secure" and "insecure" versions of every feature, we use `createEncryptedKvLww` to wrap the standard `YKeyValueLww` structure. Every value, whether it's a transcript, a note, or a setting, is serialized and encrypted with XChaCha20-Poly1305 before it ever touches the underlying Y.Doc.

```typescript
const kv = createEncryptedKvLww(yarray, {
  key: session.encryptionKey,
});
```

We use `@noble/ciphers` for the implementation because it's synchronous and Cure53-audited. Keeping encryption synchronous is vital for local-first apps; it ensures that `set()` remains a void operation that doesn't force the UI to wait for a promise. When a key is present, the wrapper stores a versioned blob containing the ciphertext with the nonce packed in. If no key is provided, it's a zero-overhead passthrough.

| Mode | Key source | Server can decrypt? |
|---|---|---|
| Cloud | Server derives from `ENCRYPTION_SECRETS` | Yes |
| Self-hosted | Server derives from your `ENCRYPTION_SECRETS` | Only your server |
| Local / no encryption | No key → passthrough | N/A |

This single code path handles every trust model Epicenter supports today. In the hosted cloud, Epicenter infrastructure owns `ENCRYPTION_SECRETS`, so Epicenter sits inside the trust boundary. In a self-hosted deployment, you own that secret and the server that uses it. The mechanism stays the same; the trust boundary moves to your infrastructure.

## Related

- [Why E2E Encryption Keeps Failing](./why-e2e-encryption-keeps-failing.md): PGP, the jasode argument, and Signal as case studies
- [If You Don't Trust the Server, Become the Server](./if-you-dont-trust-the-server-become-the-server.md): self-hosting as the clean answer to zero-knowledge
- [Encryption at Rest Is the Gold Standard](./encryption-at-rest-is-the-gold-standard.md): how Epicenter encrypts sensitive data at rest
