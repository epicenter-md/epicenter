import { defineConfig } from 'vite';

/**
 * The one build setting an installed Epicenter app needs, and it is not about
 * `@epicenter/app`.
 *
 * Epicenter serves every catalog member below `/apps/<id>/` (ADR-0179), and an
 * app does not know its own id at build time. Vite's default base of `/` would
 * emit `/assets/index-*.js`, which resolves against the origin root and 404s
 * for every app but the one that happens to be mounted there. A relative base
 * emits `./assets/index-*.js`, which is correct at any mount path.
 */
export default defineConfig({
	base: './',
});
