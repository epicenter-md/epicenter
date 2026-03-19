---
name: better-auth-security-best-practices
description: Configure rate limiting, manage auth secrets, set up CSRF protection, define trusted origins, secure sessions and cookies, encrypt OAuth tokens, track IP addresses, and implement audit logging for Better Auth. Use when users need to secure their auth setup, prevent brute force attacks, or harden a Better Auth deployment.
metadata:
  author: epicenter
  version: '1.0'
---

## Secret Management

### Configuring the Secret

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET, // or via `BETTER_AUTH_SECRET` env
});
```

Better Auth looks for secrets in this order:
1. `options.secret` in your config
2. `BETTER_AUTH_SECRET` environment variable
3. `AUTH_SECRET` environment variable

### Secret Requirements

- Rejects default/placeholder secrets in production
- Warns if shorter than 32 characters or entropy below 120 bits
- Generate: `openssl rand -base64 32`
- Never commit secrets to version control

## Rate Limiting

Enabled in production by default. Applies to all endpoints. Plugins can override per-endpoint.

### Default Configuration

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  rateLimit: {
    enabled: true, // Default: true in production
    window: 10, // Time window in seconds (default: 10)
    max: 100, // Max requests per window (default: 100)
  },
});
```

### Storage Options

Options: `"memory"` (resets on restart, avoid on serverless), `"database"` (persistent), `"secondary-storage"` (Redis, default when available).

```ts
rateLimit: {
  storage: "database",
}
```

### Custom Storage

Implement your own rate limit storage:

```ts
rateLimit: {
  customStorage: {
    get: async (key) => {
      // Return { count: number, expiresAt: number } or null
    },
    set: async (key, data) => {
      // Store the rate limit data
    },
  },
}
```

### Per-Endpoint Rules

Sensitive endpoints default to 3 requests per 10 seconds (`/sign-in`, `/sign-up`, `/change-password`, `/change-email`). Override:

```ts
rateLimit: {
  customRules: {
    "/api/auth/sign-in/email": {
      window: 60, // 1 minute window
      max: 5, // 5 attempts
    },
    "/api/auth/some-safe-endpoint": false, // Disable rate limiting
  },
}
```

## CSRF Protection

Multi-layer protection: origin header validation, Fetch Metadata checks, and first-login protection.

### Configuration

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  advanced: {
    disableCSRFCheck: false, // Default: false (keep enabled)
  },
});
```

Only disable for testing or with an alternative CSRF mechanism.

## Trusted Origins

### Configuring Trusted Origins

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  baseURL: "https://api.example.com",
  trustedOrigins: [
    "https://app.example.com",
    "https://admin.example.com",
  ],
});
```

The `baseURL` origin is automatically trusted. Also configurable via env: `BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.com,https://admin.example.com`

### Wildcard Patterns

```ts
trustedOrigins: [
  "*.example.com", // Matches any subdomain
  "https://*.example.com", // Protocol-specific wildcard
  "exp://192.168.*.*:*/*", // Custom schemes (e.g., Expo)
]
```

### Dynamic Trusted Origins

Compute trusted origins based on the request:

```ts
trustedOrigins: async (request) => {
  // Validate against database, header, etc.
  const tenant = getTenantFromRequest(request);
  return [`https://${tenant}.myapp.com`];
}
```

Validates `callbackURL`, `redirectTo`, `errorCallbackURL`, `newUserCallbackURL`, and `origin` against trusted origins. Invalid URLs receive 403.

## Session Security

### Session Expiration

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days (default)
    updateAge: 60 * 60 * 24, // Refresh session every 24 hours (default)
  },
});
```

### Session Caching Strategies

Cache session data in cookies to reduce database queries:

```ts
session: {
  cookieCache: {
    enabled: true,
    maxAge: 60 * 5, // 5 minutes
    strategy: "compact", // Options: "compact", "jwt", "jwe"
  },
}
```

Strategies: `"compact"` (Base64url + HMAC, smallest), `"jwt"` (HS256, standard), `"jwe"` (encrypted, use when session has sensitive data).

## Cookie Security

Defaults: `secure: true` (HTTPS/production), `sameSite: "lax"`, `httpOnly: true`, `path: "/"`, prefix `__Secure-`.

### Custom Cookie Configuration

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  advanced: {
    useSecureCookies: true, // Force secure cookies
    cookiePrefix: "myapp", // Custom prefix (default: "better-auth")
    defaultCookieAttributes: {
      sameSite: "strict", // Stricter CSRF protection
      path: "/auth", // Limit cookie scope
    },
  },
});
```

### Cross-Subdomain Cookies

```ts
advanced: {
  crossSubDomainCookies: {
    enabled: true,
    domain: ".example.com", // Note the leading dot
    additionalCookies: ["session_token", "session_data"],
  },
}
```

Only enable if you need authentication sharing and trust all subdomains.

## OAuth / Social Provider Security

PKCE is automatic for all OAuth flows. State tokens are 32-char random strings expiring after 10 minutes.

### State Parameter Storage

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  account: {
    storeStateStrategy: "cookie", // Options: "cookie" (default), "database"
  },
});
```

### Encrypting OAuth Tokens

```ts
account: {
  encryptOAuthTokens: true, // Uses AES-256-GCM
}
```

Enable if storing OAuth tokens for API access on behalf of users. Use `skipStateCookieCheck: true` only for mobile apps that cannot maintain cookies.

## IP-Based Security

### IP Address Configuration

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip"], // Headers to check
      disableIpTracking: false, // Keep enabled for rate limiting
    },
  },
});
```

Set `ipv6Subnet` (128, 64, 48, 32; default 64) to group IPv6 addresses. Enable `trustedProxyHeaders: true` only if behind a trusted reverse proxy.

## Database Hooks for Security Auditing

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  databaseHooks: {
    session: {
      create: {
        after: async ({ data, ctx }) => {
          await auditLog("session.created", {
            userId: data.userId,
            ip: ctx?.request?.headers.get("x-forwarded-for"),
            userAgent: ctx?.request?.headers.get("user-agent"),
          });
        },
      },
      delete: {
        before: async ({ data }) => {
          await auditLog("session.revoked", { sessionId: data.id });
        },
      },
    },
    user: {
      update: {
        after: async ({ data, oldData }) => {
          if (oldData?.email !== data.email) {
            await auditLog("user.email_changed", {
              userId: data.id,
              oldEmail: oldData?.email,
              newEmail: data.email,
            });
          }
        },
      },
    },
    account: {
      create: {
        after: async ({ data }) => {
          await auditLog("account.linked", {
            userId: data.userId,
            provider: data.providerId,
          });
        },
      },
    },
  },
});
```

Return `false` from a `before` hook to prevent an operation.

## Background Tasks

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  advanced: {
    backgroundTasks: {
      handler: (promise) => {
        // Platform-specific handler
        // Vercel: waitUntil(promise)
        // Cloudflare: ctx.waitUntil(promise)
        waitUntil(promise);
      },
    },
  },
});
```

Ensures operations like sending emails don't affect response timing.

## Account Enumeration Prevention

Built-in: consistent response messages, dummy operations on invalid requests, background email sending. Return generic error messages ("Invalid credentials") rather than specific ones ("User not found").

## Complete Security Configuration Example

```ts
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: "https://api.example.com",
  trustedOrigins: [
    "https://app.example.com",
    "https://*.preview.example.com",
  ],
  
  // Rate limiting
  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
    customRules: {
      "/api/auth/sign-in/email": { window: 60, max: 5 },
      "/api/auth/sign-up/email": { window: 60, max: 3 },
    },
  },
  
  // Session security
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 24 hours
    freshAge: 60 * 60, // 1 hour for sensitive actions
    cookieCache: {
      enabled: true,
      maxAge: 300,
      strategy: "jwe", // Encrypted session data
    },
  },
  
  // OAuth security
  account: {
    encryptOAuthTokens: true,
    storeStateStrategy: "cookie",
  },
  
  
  // Advanced settings
  advanced: {
    useSecureCookies: true,
    cookiePrefix: "myapp",
    defaultCookieAttributes: {
      sameSite: "lax",
    },
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for"],
      ipv6Subnet: 64,
    },
    backgroundTasks: {
      handler: (promise) => waitUntil(promise),
    },
  },
  
  // Security auditing
  databaseHooks: {
    session: {
      create: {
        after: async ({ data, ctx }) => {
          console.log(`New session for user ${data.userId}`);
        },
      },
    },
    user: {
      update: {
        after: async ({ data, oldData }) => {
          if (oldData?.email !== data.email) {
            console.log(`Email changed for user ${data.id}`);
          }
        },
      },
    },
  },
});
```

## Security Checklist

Before deploying to production:

- [ ] **Secret**: Use a strong, unique secret (32+ characters, high entropy)
- [ ] **HTTPS**: Ensure `baseURL` uses HTTPS
- [ ] **Trusted Origins**: Configure all valid origins (frontend, mobile apps)
- [ ] **Rate Limiting**: Keep enabled with appropriate limits
- [ ] **CSRF Protection**: Keep enabled (`disableCSRFCheck: false`)
- [ ] **Secure Cookies**: Enabled automatically with HTTPS
- [ ] **OAuth Tokens**: Consider `encryptOAuthTokens: true` if storing tokens
- [ ] **Background Tasks**: Configure for serverless platforms
- [ ] **Audit Logging**: Implement via `databaseHooks` or `hooks`
- [ ] **IP Tracking**: Configure headers if behind a proxy
