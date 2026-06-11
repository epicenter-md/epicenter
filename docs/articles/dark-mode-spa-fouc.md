# Dark Mode in SPAs: Why You're Getting a Flash of White

If you've built a single-page application with dark mode support, you've probably seen it: the page loads, flashes white for a split second, then snaps to dark. It's jarring. Users notice. And it's surprisingly tricky to fix.

## The Problem

In a typical SPA setup. SvelteKit with `ssr: false`, Vite, or any statically-generated site. Your HTML is served before JavaScript runs. The browser renders the page, _then_ your JavaScript hydrates, reads the user's theme preference, and applies the dark class.

That gap between "HTML rendered" and "JavaScript executed" is where the flash happens.

## Why localStorage Makes This Tricky

Most dark mode implementations store the user's preference in `localStorage`. It's simple, persistent, and works across sessions. Libraries like [mode-watcher](https://github.com/svecosystem/mode-watcher) do this automatically.

The problem is _when_ your app can read that preference.

In an SPA, the browser receives HTML, starts rendering, applies CSS, and _then_ runs your JavaScript. By the time your code calls `localStorage.getItem('theme')`, the user has already seen the page. If it rendered light and they wanted dark, you get the flash.

"Okay," you might think, "just use CSS instead of JavaScript. CSS applies before the page is visible."

That's where `prefers-color-scheme` comes in:

```css
@media (prefers-color-scheme: dark) {
	:root {
		background-color: #1a1a1a;
	}
}
```

This reads the user's operating system preference and applies styles before the page is visible. No JavaScript required, no flash. For many apps, this is all you need.

## The Edge Case: SPAs with localStorage

The CSS approach breaks down when your app stores the user's theme preference in `localStorage`, which is what most theme libraries (like [mode-watcher](https://github.com/svecosystem/mode-watcher)) do to persist choices across sessions.

CSS media queries read system settings; they have no way to access localStorage. If someone's OS is set to light mode but they explicitly chose dark mode in your app's theme toggle, CSS can't know. The page renders light, JavaScript finally runs, reads "dark" from localStorage, applies the class, and you get the flash.



Here's the tricky scenario:

1. User's OS is set to **light mode**
2. User explicitly chooses **dark mode** in your app (saved to `localStorage`)
3. On page reload:
   - CSS media query sees OS preference → shows light background
   - JavaScript hydrates, reads `localStorage` → switches to dark
   - User sees a brief light-to-dark flash

The problem: CSS can only see the OS preference via `prefers-color-scheme`. It has no way to access `localStorage` where the user's explicit choice is stored.

## The Solution: A Blocking Inline Script

For CSR/SPA/SSG apps, add this inline script to your HTML **before** any stylesheets:

```html
<script>
	const mode = localStorage.getItem('mode-watcher-mode') ?? 'system';
	const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
	const isDark = mode === 'dark' || (mode === 'system' && prefersDark);
	document.documentElement.classList.toggle('dark', isDark);
	document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
</script>
```

This covers all three cases:

- **Explicit `dark`** → respects the user's choice
- **Explicit `light`** → respects the user's choice
- **`system`** → defers to OS preference (same behavior as the CSS approach)

Since the script runs synchronously before first paint, there's no flash. It also sets `color-scheme` for native elements like scrollbars and form controls.

## Why Not Defer or Async?

You might wonder why we can't just use `defer` or put this in a module. The answer is timing: deferred scripts run after the DOM is parsed, and modules are deferred by default. By then, the browser has already painted the page.

We _want_ this script to block. It's tiny and reads from localStorage, which is synchronous and fast. The blocking time is negligible, but it ensures the theme is set before first paint.

## What About Server-Side Rendering?

If you're using SSR, you have more options. SvelteKit provides `%sveltekit.nonce%` for CSP-compliant inline scripts, and you can use `hooks.server.ts` to inject theme logic at request time.

But for prerendered or statically-generated pages, server hooks don't run when users request the page. They only run at build time. The HTML is already baked. That's why the inline script approach is necessary.

## The Full Picture

| Rendering Mode             | Solution                                               |
| -------------------------- | ------------------------------------------------------ |
| SSR                        | Works out of the box, or use `hooks.server.ts` for CSP |
| SSR + CSP                  | `%sveltekit.nonce%` + `hooks.server.ts`                |
| CSR / SSG / adapter-static | Inline script in `app.html`                            |

## References

- [SvelteKit issue #13307](https://github.com/sveltejs/kit/issues/13307#issuecomment-3690858517): Discussion of this problem and the solution
- [mode-watcher docs PR](https://github.com/svecosystem/mode-watcher/pull/160): Adding CSR/SPA documentation to mode-watcher
- [Whispering FOUC fix](https://github.com/EpicenterHQ/epicenter/pull/1168): Real-world implementation that prompted this investigation
- [Leftium's CSS approach](https://github.com/EpicenterHQ/epicenter/pull/1154): An alternative CSS-only approach (works when user preference matches OS)

---

The flash of unstyled content in dark mode SPAs is one of those problems that seems simple until you dig in. The solution is straightforward once you understand _why_ it happens: localStorage requires JavaScript, JavaScript runs after HTML renders, so you need a blocking script to bridge the gap.

Five lines of code in your `<head>`. No flash.
