---
name: better-auth-security-best-practices
description: 'The two Better Auth security decisions this repository has made that upstream docs will not tell you: which origins are trusted in production, and which providers may bypass the email-verified gate when linking accounts. Use when reviewing auth security, configuring trustedOrigins or trustedProviders, or enabling a new sign-in provider. Do not use for Better Auth setup, schema, adapters, or plugin wiring; use better-auth-best-practices for those, and ask DeepWiki for upstream option semantics.'
metadata:
  author: epicenter
  version: '2.0'
---

## Reference Repositories

- [Better Auth](https://github.com/better-auth/better-auth) : TypeScript authentication framework with plugins

## Upstream Grounding

Rate limits, cookie flags, session expiry, CSRF options, secret handling, token
encryption, and OAuth defaults are upstream behavior with upstream defaults.
Ask DeepWiki a narrow question against `better-auth/better-auth`, then verify
the decisive detail against local installed types or source before changing
code.

This skill deliberately keeps no local copy of those option tables. A
transcribed default is worse than no default, because it goes stale silently
and reads as authoritative: the copy this file used to carry had already
drifted from its own prose on `sameSite`.

## Trusted Origins Are Not Only About Cookies

`trustedOrigins` gates `callbackURL`, `redirectTo`, `errorCallbackURL`,
`newUserCallbackURL`, and `origin`, not only cookie CSRF. A permanent
`localhost` entry in a production list therefore widens the open-redirect
surface rather than merely loosening a cookie check.

Derive the dev-versus-prod fork from the deployment's own origin, meaning its
baked `baseURL` or resolved env origin, and never from the request. A
request-derived fork is attacker-controlled, which is the whole problem. Reuse
the same fork for the cookie config so the two cannot disagree.

```ts
// localhost dev origins are trusted ONLY on a local deployment.
function buildTrustedOrigins(baseURL: string): string[] {
	const prod = [...productionOrigins];
	return isLocalDeployment(baseURL) ? [...prod, ...devOrigins] : prod;
}
```

## Account Linking Is An Account-Takeover Surface

When a social sign-in matches an existing user by email, the link gate is
(better-auth 1.5.6 `oauth2/link-account`):

```txt
block linking if: (!isTrustedProvider && !userInfo.emailVerified)
                  || accountLinking.enabled === false
                  || accountLinking.disableImplicitLinking === true
```

A provider listed in `account.accountLinking.trustedProviders` bypasses the
incoming `emailVerified` check entirely. Everything below follows from that one
fact.

`trustedProviders` may contain only identity providers that always assert a
verified email. Google does. GitHub does not, because it can return an
unverified primary email, so never add `github`. An untrusted GitHub identity
still links when GitHub reports the email verified, which is the safe behavior
and is why leaving it untrusted costs nothing.

Never list `email-password` in `trustedProviders`, and do not enable
`emailAndPassword` without both `emailVerification.sendVerificationEmail` and
`requireEmailVerification`. On versions before the unconditional
`requireLocalEmailVerified` gate, and 1.5.6 has no such option, an attacker can
pre-register an unverified local account at a victim's email and have the
victim's later trusted-provider sign-in link into it.

If there is no email sender, prefer social-IdP-only sign-in over local
credentials. That closes the takeover at the root instead of gating it.
