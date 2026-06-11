# Pin Your Chrome Extension ID or OAuth Breaks

When you're developing a Chrome extension with a framework like WXT, Chrome generates the extension ID from the absolute path of the unpacked extension folder. Different developer, different path, different ID. Every URL tied to that ID. OAuth redirects, `chrome.identity.getRedirectURL()`, externally connectable allowlists. Breaks silently.

```
/Users/alice/code/my-ext/.output/chrome-mv3  → ID: abcdefghijklmnop  ✅
/Users/bob/projects/my-ext/.output/chrome-mv3 → ID: qrstuvwxyzabcdef  ❌
```

The fix is a single manifest field. Add a `key` to your manifest, and Chrome derives the ID from that key instead of the filesystem path. Same key in the repo, same ID on every machine.

## Generating a Key

No Chrome Web Store upload needed. Two commands:

```bash
# Generate a private key, extract the public key in Chrome's format
openssl genrsa 2048 > ext-key.pem
openssl rsa -in ext-key.pem -pubout -outform DER 2>/dev/null | base64 | tr -d '\n'
```

That outputs a base64 string starting with `MIIBIj...`. That's your manifest key. You can also compute the resulting extension ID upfront:

```bash
openssl rsa -in ext-key.pem -pubout -outform DER 2>/dev/null \
  | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p'
```

Discard the `.pem` after. Chrome only needs the public key in the manifest.

## Adding It in WXT

WXT generates `manifest.json` from `wxt.config.ts`. The `manifest` object accepts any valid Chrome manifest field, and `key` passes through untouched:

```typescript
export default defineConfig({
  manifest: {
    key: 'MIIBIjANBgkqhkiG9w0BAQE...',
    permissions: ['identity'],
  },
});
```

That's it. Every developer who clones the repo gets the same extension ID, the same `chromiumapp.org` redirect URL, and OAuth just works.
