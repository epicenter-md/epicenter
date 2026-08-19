---
name: better-auth-security-best-practices
description: 'Better Auth security hardening: rate limits, secrets, CSRF, trusted origins, cookies, sessions, OAuth tokens, and audit logging. Use when reviewing auth security, brute-force protection, token handling, or deployment safety.'
metadata:
  author: epicenter
  version: '1.0'
---

## Reference Repositories

- [Better Auth](https://github.com/better-auth/better-auth) — TypeScript authentication framework with plugins

## Upstream Grounding

When Better Auth rate limiting, CSRF and origin checks, cookie settings, secret handling, token encryption, audit behavior, or deployment security defaults affect correctness, ask DeepWiki a narrow question against `better-auth/better-auth` before relying on memory. Use it to orient, then verify decisive details against local installed types, source, or official docs before changing code.

Read [references/configuration.md](references/configuration.md) when configuring
or auditing an option: secrets, rate limiting, CSRF, trusted-origin syntax,
sessions, cookies, OAuth token encryption, IP resolution, audit hooks, and a
full worked configuration. Those are upstream defaults that move between
versions, so confirm decisive ones against installed types before relying on
them.

The two sections below are not upstream defaults. They are decisions this
repository made, and getting either wrong is an account-takeover or
open-redirect surface rather than a misconfiguration.

## Do Not Trust Localhost In Production

`trustedOrigins` gates redirect/callback URLs, not only cookie CSRF, so a
permanent `localhost` entry in a production list widens the open-redirect
surface (and Better Auth's docs warn against it). Derive the dev-vs-prod fork
from the deployment's own origin (its baked `baseURL` / resolved env origin),
never from the request, and reuse the same fork as the cookie config:

```ts
// localhost dev origins are trusted ONLY on a local deployment.
function buildTrustedOrigins(baseURL: string): string[] {
  const prod = [...productionOrigins];
  return isLocalDeployment(baseURL) ? [...prod, ...devOrigins] : prod;
}
```

## Account Linking and Provider Trust

Implicit account linking is an account-takeover surface. When a social sign-in
matches an existing user by email, the link gate is (better-auth 1.5.6
`oauth2/link-account`):

```txt
block linking if: (!isTrustedProvider && !userInfo.emailVerified)
                  || accountLinking.enabled === false
                  || accountLinking.disableImplicitLinking === true
```

A provider in `account.accountLinking.trustedProviders` **bypasses the incoming
`emailVerified` check**. So the rule is:

- `trustedProviders` may contain ONLY identity providers that always assert a
  verified email. Google does. GitHub does NOT (it can return an unverified
  primary email), so never add `github` to `trustedProviders`; an untrusted
  GitHub identity still links when GitHub reports the email verified, which is
  the safe behavior.
- Never list `email-password` in `trustedProviders`, and do not enable
  `emailAndPassword` without `emailVerification.sendVerificationEmail` +
  `requireEmailVerification`. On better-auth versions before the unconditional
  `requireLocalEmailVerified` gate (e.g. 1.5.6 has no such option), an attacker
  can pre-register an unverified local account at a victim's email and have the
  victim's later trusted-provider sign-in link into it.
- If you have no email sender, prefer social-IdP-only sign-in over local
  credentials. That is what closes the takeover at the root.

