// Matter is a client-side SPA (adapter-static). Disable SSR so everything
// renders in the browser; the Tauri build will reuse the same static output.
export const ssr = false;

// E2E only: install the in-memory Tauri IPC mock before any route mounts and calls `invoke`. The
// branch is compiled out of the real build (`import.meta.env.VITE_E2E` is undefined there), so it
// adds nothing to production. See `src/lib/e2e/install-mocks.ts`.
export async function load(): Promise<void> {
	if (import.meta.env.VITE_E2E) {
		const { installMocks } = await import('$lib/e2e/install-mocks');
		installMocks();
	}
}
