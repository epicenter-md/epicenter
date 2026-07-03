/**
 * E2E stub for `@tauri-apps/plugin-dialog`, swapped in by `vite.e2e.config.ts`'s alias.
 *
 * The real plugin module is imported at module-eval time by `open-vaults.svelte.ts`, before any
 * mock-install hook can run, so aliasing the whole module (not just mocking its `invoke`) is what
 * keeps a plain browser from crashing on boot. The e2e tests deep-link the vault route, so `open`
 * is rarely called; it returns the fixture root if it is.
 */

import { E2E_ROOT } from './install-mocks';

export async function open(): Promise<string> {
	return E2E_ROOT;
}
