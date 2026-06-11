# `Authorization: Bearer` Is the Envelope, Not the Token

Bearer token is a transport mechanism: `Authorization: Bearer <something>`. The `<something>` can be:

- **Opaque**: a random string (e.g., `abc123xyz`). Requires a database lookup to validate. This is what Better Auth's `session_token` is.
- **JWT**: a self-contained signed JSON blob (e.g., `eyJhbG...`). Can be validated locally by checking the signature against a public key (JWKS). No database needed.

Both travel the same way. The difference is where validation happens.

```
Opaque:                              JWT:

Authorization: Bearer abc123xyz      Authorization: Bearer eyJhbG...
        │                                    │
        ▼                                    ▼
  DB lookup                          verify signature
  WHERE token = 'abc123xyz'          against JWKS (cached)
        │                                    │
        ▼                                    ▼
  { userId, expiry }                 decode payload directly
```

Opaque tokens are cheap to revoke: delete the row and they're dead immediately. JWTs are cheap to validate, no database, just a signature check. But revoking a JWT before expiry means maintaining a blocklist, which gets you back to a DB lookup anyway.

Use opaque tokens for same-origin sessions. Use JWTs when a third party needs to validate tokens without calling back to your server.
