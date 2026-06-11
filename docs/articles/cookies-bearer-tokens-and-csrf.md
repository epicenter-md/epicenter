# Cookies, Bearer Tokens, and CSRF

Three concepts that get tangled together in every auth discussion. Here's what each one actually is and how they interact.

## httpOnly cookies

A cookie with the `HttpOnly` flag. The server sets it via `Set-Cookie`, the browser stores it, and the browser sends it on every request to that domain. JavaScript can't read it via `document.cookie`.

```
Server → Set-Cookie: session=abc123; HttpOnly; Secure
Browser stores it. JS can't see it.
Browser → Cookie: session=abc123  (on every request, automatically)
```

The browser does all the work. Zero client code.

## Bearer tokens

A string your code stores (localStorage, memory, a file) and manually attaches to each request. The browser does nothing automatically.

```
Sign-in response → { token: "abc123" }
You store it: localStorage.setItem('app.auth.token', 'abc123')
You send it: Authorization: Bearer abc123  (manually, every request)
```

Three steps instead of zero. The trade-off is portability: this works in browsers, desktop apps, Chrome extensions, CLI tools, anywhere you can make an HTTP request.

## CSRF (Cross-Site Request Forgery)

An attack where a malicious site tricks the browser into making a request to your API. It works because cookies are automatic.

```
User is logged into api.epicenter.so (has session cookie)
User visits evil.com
evil.com runs: fetch('https://api.epicenter.so/delete-account', { credentials: 'include' })
Browser attaches the session cookie automatically
Server sees valid session, processes the request
```

The server can't tell the difference between this and a real request. The cookie is valid. The origin might even be allowed by CORS.

Defenses: `SameSite=Lax` cookies (blocks cross-site POST), CSRF tokens (server generates a random token that the real app includes but the attacker can't guess), origin validation.

## Bearer tokens are immune to CSRF

The browser never attaches Bearer tokens automatically. `evil.com` can make a request to your API, but without the `Authorization` header, it's unauthenticated. The attacker would need XSS to read the token from localStorage first. And that's a different attack entirely.

## The trade-off

|                        | Cookies (httpOnly) | Bearer (localStorage) |
|------------------------|--------------------|-----------------------|
| Token readable by JS   | No                 | Yes                   |
| Sent automatically     | Yes                | No                    |
| Vulnerable to CSRF     | Yes                | No                    |
| Vulnerable to XSS theft| No                 | Yes                   |
| Works outside browsers | No                 | Yes                   |

Each approach is vulnerable to one class of attack the other isn't.

## Why neither matters much once XSS exists

If an attacker has XSS on your app, they don't need to steal the token or forge a cross-site request. They're running code inside your app, on your origin, with your user's session. They make requests directly:

```javascript
// Attacker's XSS payload. Works regardless of auth strategy
fetch('/api/sensitive-action', {
  method: 'POST',
  credentials: 'include',  // cookies sent automatically
  headers: { 'Authorization': `Bearer ${localStorage.getItem('app.auth.token')}` }
});
```

With cookies, the `credentials: 'include'` line is enough. With Bearer tokens, they read localStorage. Either way, the request succeeds. The attacker can do anything the user can do for as long as the XSS is live.

httpOnly cookies prevent one specific thing: the attacker copying the token to use from another machine after the XSS is patched. That's real, but narrow.

The actual defense is preventing XSS: Content-Security-Policy headers, input sanitization, output encoding. Not choosing between two storage mechanisms that are both compromised once XSS exists.

## See also

- [Why Epicenter Uses Bearer Tokens Everywhere](./why-epicenter-uses-bearer-tokens-everywhere.md)
- [Origin Allowlists Don't Stop XSS](./origin-allowlists-dont-stop-xss.md)
- [Bearer Tokens Are Cookies Without the Cookie Jar](./bearer-tokens-are-cookies-without-the-cookie-jar.md)
