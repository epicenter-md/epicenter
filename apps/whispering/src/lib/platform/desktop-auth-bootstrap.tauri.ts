import type { DesktopAuthBootstrap } from '@epicenter/auth/desktop';

const element = document.querySelector<HTMLScriptElement>(
	'#epicenter-auth-bootstrap',
);
if (!element) {
	throw new Error('Epicenter did not provide the desktop auth bootstrap.');
}

let value: DesktopAuthBootstrap;
try {
	value = JSON.parse(element.textContent ?? '') as DesktopAuthBootstrap;
} catch (cause) {
	throw new Error('Epicenter provided an invalid desktop auth bootstrap.', {
		cause,
	});
} finally {
	element.remove();
}

/** Immutable deployment and identity snapshot for this WebView generation. */
export const desktopAuthBootstrap = value;
