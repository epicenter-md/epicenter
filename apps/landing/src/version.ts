/**
 * The Whispering release version the landing download links point at.
 *
 * Stamped by CI on each release (`scripts/bump-version.ts`), in lockstep with
 * every app's `package.json` version. Landing is its only reader (the download
 * buttons and the version label on the Whispering page), so it lives here
 * rather than in a shared package.
 */
export const VERSION = '7.11.0';
