/**
 * Shared CSS for server-rendered auth pages (sign-in, consent, signed-in,
 * cli-callback).
 *
 * Mirrors the Epicenter design system tokens from `packages/ui/src/app.css`
 * (its oklch light/dark palettes and system-ui font stack) as plain custom
 * properties, so these pages theme themselves from `prefers-color-scheme`
 * without pulling in Tailwind or the UI package. Semantic surfaces (alerts)
 * derive their fills from the accent via `color-mix`, so each stays legible in
 * both themes from a single hue token.
 *
 * Two page shapes share this sheet:
 * - `body.centered` + `.card`: the single centered card (consent, cli-callback)
 * - `body.split` + `.shell`: the two-pane sign-in surface (brand panel left,
 *   auth pane right; single column on small screens)
 *
 * This string is inlined in the `<style>` tag by the layout component, which
 * must wrap it in `raw()`: hono/jsx escapes text children, and an escaped
 * quote (`&quot;Segoe UI&quot;`) invalidates the font-family declaration.
 */
export const AUTH_STYLES = `
:root{
	color-scheme:light dark;
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
	background:var(--bg);
	color:var(--fg);
	line-height:1.5;
	-webkit-font-smoothing:antialiased;
}
body.centered{
	display:flex;
	align-items:center;
	justify-content:center;
	padding:1rem;
}

/* ── Logo (centered card pages) ───────────────────────────── */

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

/* ── Cards ────────────────────────────────────────────────── */

.card,.auth-panel{
	background:var(--card);
	border:1px solid var(--border);
	border-radius:16px;
	padding:2.5rem 2.25rem;
	max-width:400px;
	width:100%;
	box-shadow:var(--shadow);
}
.auth-panel{
	max-width:430px;
}

h1{font-size:1.375rem;font-weight:650;letter-spacing:-.015em;margin-bottom:.25rem}
.subtitle{color:var(--muted-fg);font-size:.875rem;margin-bottom:1.75rem}

/* ── Split shell (sign-in, signed-in) ─────────────────────────
   Small screens: one column, auth pane directly under the brand
   lockup so the sign-in action is visible without scrolling; the
   local-first explanation (.brand-copy) collapses below it via
   display:contents + order. Wide screens: brand panel left, auth
   sheet right. */

.shell{
	min-height:100vh;
	min-height:100dvh;
	display:flex;
	flex-direction:column;
}
.brand{display:contents}
.brand-lockup{
	display:flex;
	align-items:center;
	gap:.625rem;
	padding:1.25rem 1.5rem .75rem;
}
.brand-lockup svg{width:30px;height:30px;border-radius:9px}
.brand-name{font-size:1.0625rem;font-weight:650;letter-spacing:-.015em}

.brand-copy{
	order:1;
	margin-top:auto;
	padding:2rem 1.5rem 2.5rem;
	border-top:1px solid var(--border);
}
.brand-statement{
	font-size:1.25rem;
	font-weight:600;
	letter-spacing:-.02em;
	line-height:1.25;
}
.brand-support{
	margin-top:.625rem;
	color:var(--muted-fg);
	font-size:.875rem;
	line-height:1.6;
	max-width:44ch;
}
.brand-proofs{
	margin-top:1.25rem;
	list-style:none;
	display:flex;
	flex-direction:column;
	gap:.625rem;
}
.brand-proofs li{
	display:flex;
	align-items:center;
	gap:.625rem;
	color:var(--muted-fg);
	font-size:.875rem;
}
.brand-proofs svg{width:15px;height:15px;color:var(--success);flex:none}

.pane{
	display:flex;
	justify-content:center;
	padding:1.5rem 1.5rem 2.5rem;
}
.auth-panel h1,.auth-panel .subtitle{text-align:center}

@media (min-width:900px){
	.shell{
		display:grid;
		grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);
	}
	.brand{
		display:flex;
		flex-direction:column;
		padding:2.25rem 3rem 3rem;
	}
	.brand-lockup{padding:0}
	.brand-copy{
		margin:auto 0;
		padding:3rem 0;
		border-top:0;
	}
	.brand-statement{
		font-size:clamp(1.75rem,2.4vw,2.125rem);
		line-height:1.15;
		max-width:18ch;
	}
	.brand-support{margin-top:1rem;font-size:.9375rem}
	.brand-proofs{margin-top:2rem;gap:.75rem}
	.pane{
		border-left:1px solid var(--border);
		align-items:center;
		padding:3rem 2.5rem;
	}
}

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

.success-icon{width:40px;height:40px;margin-bottom:1.25rem;display:block}
.success-icon circle{fill:color-mix(in oklab,var(--success) 16%,var(--card))}
.success-icon path{stroke:var(--success)}

.auth-panel .success-icon{margin-left:auto;margin-right:auto}
.identity-name{font-size:.9375rem;font-weight:500;text-align:center}
.identity-email{color:var(--muted-fg);font-size:.875rem;text-align:center}
.ready-line{margin-top:1rem;color:var(--muted-fg);font-size:.8125rem;text-align:center}

.signed-in-actions{
	margin-top:1.5rem;
	display:flex;
	flex-direction:column;
	gap:.5rem;
	width:100%;
}

.signed-in-info{
	color:var(--muted-fg);
	font-size:.875rem;
	margin-top:.125rem;
}

@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;
