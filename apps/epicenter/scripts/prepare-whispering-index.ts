const BOOT_START = 'Promise.all([';
const BOOT_END = ']).then(([kit, app]) => {';
const CREDENTIAL_READY =
	'(window.__EPICENTER_WHISPERING_AUTH_READY__ ?? Promise.resolve())';

/**
 * Hold SvelteKit's module graph until Rust has preloaded the OS-keyring cell.
 * This keeps the auth module synchronous: a top-level await inside a generated
 * route node forms a cycle in WebKit and leaves the desktop surface blank.
 */
export function gateWhisperingBootstrap(html: string): string {
	requireSingle(html, BOOT_START);
	requireSingle(html, BOOT_END);
	return html
		.replace(BOOT_START, `${CREDENTIAL_READY}.then(() => Promise.all([`)
		.replace(BOOT_END, `])).then(([kit, app]) => {`);
}

function requireSingle(html: string, marker: string): void {
	const count = html.split(marker).length - 1;
	if (count !== 1) {
		throw new Error(
			`Expected one Whispering bootstrap marker ${JSON.stringify(marker)}, found ${count}.`,
		);
	}
}

if (import.meta.main) {
	const indexPath = new URL('../dist/whispering/index.html', import.meta.url);
	const html = await Bun.file(indexPath).text();
	await Bun.write(indexPath, gateWhisperingBootstrap(html));
}
