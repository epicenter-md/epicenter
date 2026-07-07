/** @jsxImportSource hono/jsx */

import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { AUTH_STYLES } from './styles';

/**
 * Epicenter logo mark, two overlapping circles.
 *
 * Matches the favicon at `apps/landing/public/favicon.svg`. Kept as a plain
 * string so both the centered-card header and the brand lockup can render it
 * at their own sizes (each context sizes it via CSS).
 */
const EPICENTER_MARK_SVG = `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
	<rect width="400" height="400" rx="60" fill="#000"/>
	<circle cx="170" cy="170" r="100" fill="#ccc"/>
	<circle cx="230" cy="230" r="100" fill="#fff"/>
</svg>`;

/**
 * Check glyph for the brand panel's proof points. Inherits `currentColor`
 * (set to the success token by `.brand-proofs svg`).
 */
const PROOF_ICON = raw(`<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
	<circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.25" opacity=".45"/>
	<path d="M5 8.2L7.2 10.4L11 6.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

/**
 * Shared HTML shell for all auth pages (sign-in, consent, signed-in,
 * cli-callback).
 *
 * Renders the full `<!DOCTYPE html>` document with viewport meta and the
 * shared CSS. The stylesheet MUST go through `raw()`: hono/jsx escapes text
 * children, and an escaped quote inside `<style>` (`&quot;Segoe UI&quot;`) is
 * not decoded by the CSS parser, which invalidates the whole `font-family`
 * declaration and drops the page to the browser's default serif.
 *
 * `bodyClass` picks the page shape: `centered` for the single-card pages
 * (consent, cli-callback via {@link AuthCard}), `split` for the two-pane
 * sign-in surface ({@link AuthShell}).
 */
export function AuthLayout({
	title,
	bodyClass,
	children,
}: {
	title: string;
	bodyClass: 'centered' | 'split';
	children: Child;
}) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<style>{raw(AUTH_STYLES)}</style>
			</head>
			<body class={bodyClass}>{children}</body>
		</html>
	);
}

/**
 * Centered card wrapper for the single-purpose pages (consent, cli-callback):
 * Epicenter mark on top, page content below. Pair with `bodyClass="centered"`.
 */
export function AuthCard({ children }: { children: Child }) {
	return (
		<div class="card">
			{raw(`<div class="logo">${EPICENTER_MARK_SVG}</div>`)}
			{children}
		</div>
	);
}

/**
 * Two-pane shell for the sign-in and signed-in pages. Pair with
 * `bodyClass="split"`.
 *
 * The brand panel carries identity and the local-first promise; the pane
 * carries the auth action. On small screens the brand panel dissolves
 * (`display:contents`): the lockup stays on top so the page is recognizably
 * Epicenter, the auth pane follows immediately so the primary action is
 * visible without scrolling, and the explanation re-orders below it.
 */
export function AuthShell({ children }: { children: Child }) {
	return (
		<div class="shell">
			<aside class="brand">
				<div class="brand-lockup">
					{raw(EPICENTER_MARK_SVG)}
					<span class="brand-name">epicenter</span>
				</div>
				<div class="brand-copy">
					<h2 class="brand-statement">Your workspace stays yours.</h2>
					<p class="brand-support">
						Sign in adds sync, backups, and hosted AI credits. Your local
						workspace still opens without an account.
					</p>
					<ul class="brand-proofs">
						<li>{PROOF_ICON}Local-first by default</li>
						<li>{PROOF_ICON}Sync when you choose</li>
						<li>{PROOF_ICON}Self-hosting stays separate</li>
					</ul>
				</div>
			</aside>
			<main class="pane">
				<section class="auth-panel" aria-labelledby="heading">
					{raw(`<div class="logo">${EPICENTER_MARK_SVG}</div>`)}
					{children}
				</section>
			</main>
		</div>
	);
}
