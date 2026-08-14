import staticAdapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Epicenter serves an installed app below `/apps/<namespace>/` (ADR-0210), so a
 * build headed there has to write that prefix into its own asset URLs: nothing
 * rewrites them afterwards, and a build that assumes it owns the site root asks
 * for `/_app/...`, gets the host's 404, and shows a blank window.
 *
 * The prefix arrives as an environment variable rather than a constant because
 * the namespace is declared once, in the workspace, and `build:epicenter` reads it
 * from there. Vocab's own deploy sets nothing and keeps the site root.
 */
const epicenterBase = process.env.EPICENTER_APP_BASE;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: staticAdapter({
			fallback: 'index.html',
		}),
		...(epicenterBase && { paths: { base: epicenterBase } }),
	},
};

export default config;
