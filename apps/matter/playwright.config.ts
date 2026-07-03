import { defineConfig, devices } from '@playwright/test';

// Layer A: drive the real Svelte UI in Chromium against the e2e dev server (mocked Tauri IPC).
// One command: `bun run test:e2e`. The webServer boots `vite.e2e.config.ts` with VITE_E2E=1 so the
// dialog stub and IPC mock are wired in; the base vite config pins port 5180.
export default defineConfig({
	testDir: './e2e',
	// `*.e2e.ts`, not `*.spec.ts`/`*.test.ts`, so `bun test` (which globs those) never tries to run
	// these browser tests as unit tests.
	testMatch: '**/*.e2e.ts',
	fullyParallel: true,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: 'http://localhost:5180',
		trace: 'on-first-retry',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'VITE_E2E=1 vite dev --config vite.e2e.config.ts',
		port: 5180,
		reuseExistingServer: !process.env.CI,
		stdout: 'ignore',
		stderr: 'pipe',
	},
});
