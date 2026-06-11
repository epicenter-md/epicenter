/** @jsxImportSource hono/jsx */

import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { AUTH_STYLES } from './styles';

/**
 * Epicenter logo mark, two overlapping circles.
 *
 * Matches the favicon at `apps/landing/public/favicon.svg` but sized for
 * inline use in the auth card header. Rendered as raw HTML to avoid JSX
 * SVG attribute noise.
 */
const EPICENTER_MARK =
	raw(`<div class="logo"><svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
	<rect width="400" height="400" rx="60" fill="#000"/>
	<circle cx="170" cy="170" r="100" fill="#ccc"/>
	<circle cx="230" cy="230" r="100" fill="#fff"/>
</svg></div>`);

/**
 * Shared HTML shell for all auth pages (sign-in, consent, signed-in, cli-callback).
 *
 * Renders the full `<!DOCTYPE html>` document with viewport meta, the shared
 * CSS, and a centered card wrapper. Each page component is passed as `children`.
 */
export function AuthLayout({
	title,
	children,
}: {
	title: string;
	children: Child;
}) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<style>{AUTH_STYLES}</style>
			</head>
			<body>
				<div class="card">
					{EPICENTER_MARK}
					{children}
				</div>
			</body>
		</html>
	);
}
