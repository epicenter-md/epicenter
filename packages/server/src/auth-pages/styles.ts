/**
 * Shared CSS for server-rendered auth pages (sign-in, consent, signed-in,
 * cli-callback).
 *
 * Matches the Epicenter design system tokens from `packages/ui/src/app.css`
 * using oklch equivalents. System-ui font stack (brand font Manrope is not
 * loaded on these standalone pages). No external dependencies. This string is
 * inlined in the `<style>` tag by the layout component.
 */
export const AUTH_STYLES = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

body{
	font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
	min-height:100vh;
	display:flex;
	align-items:center;
	justify-content:center;
	background:#f5f5f5;
	color:oklch(0.129 0.042 264.695);
	padding:1rem;
	line-height:1.5;
	-webkit-font-smoothing:antialiased;
}

/* ── Logo ────────────────────────────────────────────────── */

.logo{
	display:flex;
	justify-content:center;
	margin-bottom:1.5rem;
}
.logo svg{
	width:36px;
	height:36px;
	border-radius:8px;
}

/* ── Card ────────────────────────────────────────────────── */

.card{
	background:#fff;
	border-radius:16px;
	padding:2.5rem;
	max-width:420px;
	width:100%;
	box-shadow:0 2px 8px 0 rgb(0 0 0 / .06),0 0 0 1px rgb(0 0 0 / .04);
}

h1{font-size:1.375rem;font-weight:700;letter-spacing:-.01em;margin-bottom:.25rem}
.subtitle{color:oklch(0.554 0.046 257.417);font-size:.875rem;margin-bottom:1.75rem}

/* ── Buttons ──────────────────────────────────────────────── */

button,.btn{
	display:inline-flex;
	align-items:center;
	justify-content:center;
	gap:.5rem;
	width:100%;
	padding:.75rem 1rem;
	border-radius:8px;
	font-size:.875rem;
	font-weight:500;
	font-family:inherit;
	cursor:pointer;
	border:1px solid transparent;
	transition:opacity .15s,background-color .15s,box-shadow .15s;
	text-decoration:none;
}
button:disabled,.btn:disabled{opacity:.5;cursor:not-allowed}

.btn-primary{background:oklch(0.208 0.042 265.755);color:#fff;border-color:oklch(0.208 0.042 265.755)}
.btn-primary:hover:not(:disabled){opacity:.85}

.btn-outline{background:#fff;color:oklch(0.129 0.042 264.695);border-color:oklch(0.929 0.013 255.508)}
.btn-outline:hover:not(:disabled){background:#f9fafb}

.btn-danger{background:#fff;color:oklch(0.577 0.245 27.325);border-color:oklch(0.929 0.013 255.508)}
.btn-danger:hover:not(:disabled){background:oklch(0.971 0.013 17.38)}

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
.msg.ok{background:oklch(0.962 0.044 156.743);color:oklch(0.448 0.119 151.328);border:1px solid oklch(0.871 0.108 152.314)}
.msg.err{background:oklch(0.971 0.013 17.38);color:oklch(0.577 0.245 27.325);border:1px solid oklch(0.852 0.071 22.018)}

.hidden{display:none}

/* ── Scope list (consent page) ────────────────────────────── */

.scope-list{
	list-style:none;
	padding:0;
	margin:.75rem 0;
}
.scope-list li{
	padding:.5rem .75rem;
	background:#f9fafb;
	border:1px solid oklch(0.929 0.013 255.508);
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
	background:#f9fafb;
	border:1px solid oklch(0.929 0.013 255.508);
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
	color:oklch(0.554 0.046 257.417);
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
`;
