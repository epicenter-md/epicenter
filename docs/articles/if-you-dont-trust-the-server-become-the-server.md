# If You Don't Trust the Server, Become the Server

Zero-knowledge encryption exists because people don't trust the server operator. Fair enough. If you're storing data on someone else's infrastructure, the operator can read it. Zero-knowledge makes that mathematically impossible by ensuring the server never holds the decryption key.

The cost is enormous. No password recovery. No server-side search. No AI features. No easy device migration. Every useful feature that requires the server to read data becomes impossible or requires grotesque workarounds: key escrow, recovery codes, client-side search indexes, encrypted inference (which doesn't exist yet). You're paying a permanent tax on every feature you build, forever, to protect against one specific threat: the server operator reading your data.

Self-hosting eliminates that threat without the tax.

## Server-managed encryption becomes zero-knowledge when you own the server

When you deploy a server on your own hardware, the encryption key sits on a machine in your closet. The server decrypts data to serve requests. Search, AI, password recovery all work normally. But nobody else has access to the machine. The properties are identical to zero-knowledge: no third party can read your data. The mechanism is different: instead of mathematical guarantees, you have physical control.

This isn't a separate implementation or a compatible mode. It's the same `createEncryptedKvLww` function using XChaCha20-Poly1305 from `@noble/ciphers` for every operation. The only variable is who owns the deployment secret. In the cloud, Epicenter infrastructure owns `ENCRYPTION_SECRETS`, derives user keys on the server, and sends them to the client on authentication. When self-hosting, you own `ENCRYPTION_SECRETS` and the server that uses it. The encrypted blobs use the same bare `Uint8Array` binary header, but the trust boundary has moved from our infrastructure to yours.

```
Zero-knowledge (hosted):
  Key: User-managed password, never sent to server
  Flow: User → encrypts client-side → ciphertext → server stores blobs
  Cost: no search, no AI, no password recovery, key management ceremony

Self-hosted (Zero-knowledge):
  Key: Derived by your server from your ENCRYPTION_SECRETS
  Flow: Your server -> client receives keys on auth -> client encrypts -> server stores blobs
  Cost: you maintain a server
  Properties: nobody outside your infrastructure can read your data
```

The populations overlap almost perfectly. The people who care enough about server trust to want zero-knowledge are exactly the people technical enough to run a Docker container on a home server or a $5/month VPS. You don't need to solve the key management problem for your mom. Your mom doesn't distrust the server operator.

## The app stays simple

This is the part that matters for builders. Zero-knowledge encryption splits your codebase in two. Every feature needs a "can the server read this?" branch. Search requires a client-side index. AI requires decrypting everything on the client, sending plaintext to a third-party API (defeating the purpose), then re-encrypting. Password reset requires key escrow or recovery codes, which reintroduce the trusted third party you were trying to eliminate.

Self-hosting means one codebase. The server handles encryption, the server handles search, the server handles AI. Users who trust your hosted version use it as-is. Users who don't trust it deploy the same binary on their own infrastructure. Switching between hosted and self-hosted is changing one URL.

```
┌─────────────────────────────────────────────────────┐
│  Hosted (Epicenter Cloud)                           │
│                                                     │
│  Server: Cloudflare Workers + Durable Objects       │
│  Encryption key: our ENCRYPTION_SECRETS             │
│  Trust model: you trust Epicenter                   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Self-hosted                                        │
│                                                     │
│  Server: same binary, your VPS or home server       │
│  Encryption key: your ENCRYPTION_SECRETS            │
│  Trust model: you trust yourself                    │
└─────────────────────────────────────────────────────┘

Same app. Same API. Same features. Different trust boundary.
```

GitLab, Outline, and Mattermost all work this way. Enterprise customers who need total control deploy the product on their infrastructure. The self-hosted deployment IS the trust boundary. No special encryption scheme embedded in the app. The architecture handles it.

## The tradeoff you accept

Self-hosting means maintaining infrastructure. Updates, backups, DNS, TLS certificates, monitoring. That's real work. For a personal server running one app, it's manageable. Forgejo and similar tools have made this much easier in recent years. For a company running mission-critical infrastructure, it's a staffing decision.

But compare that tradeoff to zero-knowledge's tradeoff: permanently crippled server features, complex key management, and the constant risk that a user loses their recovery code and their data is gone forever. Self-hosting trades convenience for control. Zero-knowledge trades functionality for a mathematical guarantee that self-hosting provides physically.

For most people, the server they're already using is fine. For the people who genuinely need zero-knowledge guarantees, self-hosting is the cleaner answer.

## Related

- [Let the Server Handle Encryption](./let-the-server-handle-encryption.md): the broader argument for server-managed keys
- [Encryption at Rest Is the Gold Standard](./encryption-at-rest-is-the-gold-standard.md): how Epicenter encrypts sensitive data at rest
- [Why Epicenter Split Into Hub and Local Servers](./why-epicenter-split-into-hub-and-local-servers.md): the story of trying zero-knowledge and finding it impractical
