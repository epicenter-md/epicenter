import type { ClientInit } from '@sveltejs/kit';

// The client hook runs before route loads. That ordering matters to the browser E2E harness:
// open-vault hydration invokes the Tauri Store during child loads, so installing the IPC mock from
// a root layout load races those concurrent children. Production compiles this branch away.
export const init: ClientInit = async () => {
	if (!import.meta.env.VITE_E2E) return;
	const { installMocks } = await import('$lib/e2e/install-mocks');
	installMocks();
};
