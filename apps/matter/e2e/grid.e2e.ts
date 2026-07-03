import { expect, test } from '@playwright/test';

// The mock (src/lib/e2e/install-mocks.ts) records every write here for the write-path assertion.
declare global {
	interface Window {
		__E2E_WRITES__?: { fileName: string; content: string }[];
	}
}

// The fixture vault id deep-linked below. The app resolves `/vault/<id>` to a root via the persisted
// open-vaults list, which the e2e IPC mock serves through the Tauri Store commands. That lets the
// test skip the native picker and land straight on the live grid. See src/lib/e2e/install-mocks.ts.
const VAULT_ID = 'e2e-vault';

test('boots a mocked vault and renders its rows (read path through mocked IPC)', async ({
	page,
}) => {
	await page.goto(`/vault/${VAULT_ID}`);

	// The watch path succeeded if we never fall into the "Couldn't watch" empty state.
	await expect(page.getByText(/couldn't watch/i)).toHaveCount(0);

	// The seed deltas (matter.json + two cards) flowed through watch_folder -> parse -> grid.
	await expect(page.getByText('Card A')).toBeVisible();
	await expect(page.getByText('Card B')).toBeVisible();
});

// The write half: edit a cell and assert the UI issued the exact write_entry. A grid cell is a
// button showing the value; clicking it opens an auto-focused input that commits on Enter (see
// TextCell.svelte). The assertion reads window.__E2E_WRITES__, which captures the exact
// { fileName, content } the app sent over IPC, so it verifies the real saveField -> editField ->
// write_entry path shared by the grid and board drags.
test('editing a title cell writes the markdown file (write path)', async ({
	page,
}) => {
	await page.goto(`/vault/${VAULT_ID}`);
	await page.getByRole('button', { name: 'Card A' }).click();

	const input = page.locator('input:focus');
	await input.fill('Card A edited');
	await input.press('Enter'); // commit via saveField

	await expect
		.poll(() => page.evaluate(() => window.__E2E_WRITES__ ?? []))
		.toContainEqual(
			expect.objectContaining({
				fileName: 'card-a.md',
				content: expect.stringContaining('title: Card A edited'),
			}),
		);
});

test('dragging a board card writes the group field through saveField', async ({
	page,
}) => {
	await page.goto(`/vault/${VAULT_ID}?view=pipeline`);

	await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
	await page
		.locator('[data-board-card="card-a.md"]')
		.dragTo(page.locator('[data-board-column="done"]'));

	await expect
		.poll(() => page.evaluate(() => window.__E2E_WRITES__ ?? []))
		.toContainEqual(
			expect.objectContaining({
				fileName: 'card-a.md',
				content: expect.stringContaining('status: done'),
			}),
		);
});
