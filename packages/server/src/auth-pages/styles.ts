/**
 * Shared CSS for server-rendered auth pages (sign-in, consent, signed-in,
 * cli-callback).
 *
 * Mirrors the Epicenter design system tokens from `packages/ui/src/app.css`
 * (its oklch light/dark palettes and system-ui font stack) as plain custom
 * properties, so these pages theme themselves from `prefers-color-scheme`
 * without pulling in Tailwind or the UI package. Semantic surfaces (alerts)
 * derive their fills from the accent via `color-mix`, so each stays legible in
 * both themes from a single hue token. This string is inlined in the `<style>`
 * tag by the layout component.
 */
export const AUTH_STYLES = `
:root{
	--bg:oklch(0.9925 0.001 70);
	--card:oklch(1 0 0);
	--fg:oklch(0.129 0.042 264.695);
	--muted-fg:oklch(0.554 0.046 257.417);
	--border:oklch(0.929 0.013 255.508);
	--surface-2:oklch(0.968 0.007 247.896);
	--hover:oklch(0.968 0.007 247.896);
	--primary:oklch(0.208 0.042 265.755);
	--primary-fg:oklch(0.984 0.003 247.858);
	--ring:oklch(0.704 0.04 256.788);
	--success:oklch(0.448 0.119 151.328);
	--danger:oklch(0.577 0.245 27.325);
	--shadow:0 1px 2px rgb(0 0 0 / .04),0 8px 30px rgb(0 0 0 / .06);
}
@media (prefers-color-scheme:dark){
	:root{
		--bg:oklch(0.129 0.042 264.695);
		--card:oklch(0.208 0.042 265.755);
		--fg:oklch(0.984 0.003 247.858);
		--muted-fg:oklch(0.704 0.04 256.788);
		--border:oklch(1 0 0 / 12%);
		--surface-2:oklch(0.279 0.041 260.031);
		--hover:oklch(0.279 0.041 260.031);
		--primary:oklch(0.929 0.013 255.508);
		--primary-fg:oklch(0.208 0.042 265.755);
		--ring:oklch(0.551 0.027 264.364);
		--success:oklch(0.696 0.17 162.48);
		--danger:oklch(0.704 0.191 22.216);
		--shadow:0 1px 2px rgb(0 0 0 / .4),0 12px 40px rgb(0 0 0 / .5);
	}
}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

body{
	font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
	min-height:100vh;
	display:flex;
	align-items:center;
	justify-content:center;
	background:var(--bg);
	color:var(--fg);
	padding:1rem;
	line-height:1.5;
	-webkit-font-smoothing:antialiased;
}

/* ── Logo ────────────────────────────────────────────────── */

.logo{
	display:flex;
	justify-content:center;
	margin-bottom:1rem;
}
.logo svg{
	width:44px;
	height:44px;
	border-radius:12px;
}

/* ── Card ────────────────────────────────────────────────── */

.card{
	background:var(--card);
	border:1px solid var(--border);
	border-radius:16px;
	padding:2.5rem 2.25rem;
	max-width:400px;
	width:100%;
	box-shadow:var(--shadow);
}

h1{font-size:1.375rem;font-weight:700;letter-spacing:-.01em;margin-bottom:.25rem}
.subtitle{color:var(--muted-fg);font-size:.875rem;margin-bottom:1.75rem}

/* ── Sign-in header (mark lives in the layout above these) ─── */

.signin-head{display:flex;flex-direction:column;align-items:center;text-align:center}
.wordmark{font-size:1.375rem;font-weight:650;letter-spacing:-.02em;line-height:1.15;margin-bottom:.25rem}

/* ── Buttons ──────────────────────────────────────────────── */

button,.btn{
	display:inline-flex;
	align-items:center;
	justify-content:center;
	gap:.5rem;
	width:100%;
	padding:.75rem 1rem;
	border-radius:10px;
	font-size:.875rem;
	font-weight:500;
	font-family:inherit;
	color:var(--fg);
	cursor:pointer;
	border:1px solid transparent;
	transition:background-color .15s,border-color .15s,box-shadow .15s,opacity .15s;
	text-decoration:none;
}
button:disabled,.btn:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,.btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}

.btn-primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}
.btn-primary:hover:not(:disabled){opacity:.9}

.btn-outline{background:var(--card);color:var(--fg);border-color:var(--border)}
.btn-outline:hover:not(:disabled){background:var(--hover);border-color:var(--muted-fg)}

.btn-danger{background:var(--card);color:var(--danger);border-color:var(--border)}
.btn-danger:hover:not(:disabled){background:color-mix(in oklab,var(--danger) 8%,var(--card))}

/* ── Provider buttons (sign-in): icon column left, label centered ─ */

.providers{display:flex;flex-direction:column;gap:.625rem}
.btn-provider{
	display:grid;
	grid-template-columns:1.25rem 1fr 1.25rem;
	align-items:center;
	gap:.625rem;
	padding:.8rem 1rem;
	font-weight:550;
}
.btn-provider svg{width:18px;height:18px}
.btn-provider .btn-label{grid-column:2;text-align:center}

/* ── Passkey (returning-user) section ─────────────────────── */
/* No display rule here on purpose: the section carries .hidden until the
   inline script confirms WebAuthn support, and .hidden must win. */
.passkey-section{margin-top:.75rem}
.divider{
	display:flex;
	align-items:center;
	gap:.75rem;
	margin:.5rem 0 .75rem;
	color:var(--muted-fg);
	font-size:.6875rem;
	letter-spacing:.08em;
	text-transform:uppercase;
}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--border)}

/* ── Button row (side-by-side) ────────────────────────────── */

.actions{display:flex;gap:.5rem;margin-top:1.25rem}
.actions button,.actions .btn{flex:1}

/* ── Alert / message ──────────────────────────────────────── */

.msg{
	margin-top:1rem;
	padding:.75rem;
	border-radius:8px;
	font-size:.875rem;
	line-height:1.4;
}
.msg.ok{
	background:color-mix(in oklab,var(--success) 12%,var(--card));
	color:var(--success);
	border:1px solid color-mix(in oklab,var(--success) 30%,var(--card));
}
.msg.err{
	background:color-mix(in oklab,var(--danger) 12%,var(--card));
	color:var(--danger);
	border:1px solid color-mix(in oklab,var(--danger) 30%,var(--card));
}

.hidden{display:none}

/* ── Scope list (consent page) ────────────────────────────── */

.scope-list{
	list-style:none;
	padding:0;
	margin:.75rem 0;
}
.scope-list li{
	padding:.5rem .75rem;
	background:var(--surface-2);
	border:1px solid var(--border);
	border-radius:6px;
	font-size:.875rem;
	margin-bottom:.375rem;
}
.scope-list li:last-child{margin-bottom:0}

/* ── Client info (consent page) ───────────────────────────── */

.client-name{
	font-weight:600;
	font-size:1rem;
}

/* ── CLI callback code block ──────────────────────────────── */

.code-block{
	margin:1rem 0;
	padding:1rem;
	background:var(--surface-2);
	border:1px solid var(--border);
	border-radius:8px;
	overflow-x:auto;
}
.code-block code{
	font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
	font-size:.9375rem;
	letter-spacing:.05em;
	word-break:break-all;
}

/* ── Signed-in state ──────────────────────────────────────── */

.signed-in-center{
	display:flex;
	flex-direction:column;
	align-items:center;
	text-align:center;
}
.signed-in-center h1{margin-bottom:.5rem}

.success-icon{
	width:48px;
	height:48px;
	margin-bottom:1.25rem;
}

.signed-in-info{
	color:var(--muted-fg);
	font-size:.875rem;
	margin-top:.125rem;
}

.signed-in-actions{
	margin-top:1.5rem;
	display:flex;
	flex-direction:column;
	gap:.5rem;
	width:100%;
}

@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;
