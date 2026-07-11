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
	await expect(input).toHaveAttribute('aria-label', 'title');
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

test('arrow keys move a focused board card through saveField', async ({
	page,
}) => {
	await page.goto(`/vault/${VAULT_ID}?view=pipeline`);

	const card = page.locator('[data-board-card="card-a.md"]');
	await card.focus();
	await expect(card).toHaveAttribute(
		'aria-keyshortcuts',
		'ArrowLeft ArrowRight',
	);
	await card.press('ArrowRight');
	await expect(page.getByRole('status')).toHaveText(
		'Moving card-a.md to done.',
	);

	await expect
		.poll(() => page.evaluate(() => window.__E2E_WRITES__ ?? []))
		.toContainEqual(
			expect.objectContaining({
				fileName: 'card-a.md',
				content: expect.stringContaining('status: done'),
			}),
		);
});

test('running SQL returns rows and records the query in recent history', async ({
	page,
}) => {
	await page.goto(`/vault/${VAULT_ID}?panel=sql&table=vault`);

	const recent = page.getByRole('button', { name: 'Recent' });
	await expect(recent).toBeDisabled();
	await page.getByRole('button', { name: 'Run query' }).click();

	await expect(page.getByText('card-a', { exact: true })).toBeVisible();
	await expect(page.getByText('card-b', { exact: true })).toBeVisible();
	await expect(page.getByRole('status')).toHaveText(
		'Latest query result: 2 rows',
	);
	await expect(recent).toBeEnabled();

	await recent.click();
	await expect(page.getByRole('menuitem')).toContainText(
		'SELECT * FROM "vault"',
	);
});

test('database reference reveals the generated table definition', async ({
	page,
}) => {
	await page.goto(`/vault/${VAULT_ID}?panel=db&table=vault`);

	await expect(
		page.getByRole('heading', { name: 'SQLite projection' }),
	).toBeVisible();
	await expect(page.getByText('Database file', { exact: true })).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Copy database path' }),
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Copy terminal command' }),
	).toBeVisible();
	await page.locator('[data-slot=accordion-trigger]').click();
	await expect(page.getByText(/CREATE TABLE "vault"/)).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Copy vault schema' }),
	).toBeVisible();
});

test('collapsed navigation leaves focus on visible workspace controls', async ({
	page,
}) => {
	await page.setViewportSize({ width: 720, height: 900 });
	await page.goto(`/vault/${VAULT_ID}`);
	await expect(page.locator('[data-slot=sidebar]')).toHaveAttribute(
		'data-state',
		'collapsed',
	);

	await page.keyboard.press('Tab');
	await expect(
		page.getByRole('link', { name: 'Skip to workspace' }),
	).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(
		page.getByRole('main').getByRole('button', { name: 'Toggle Sidebar' }),
	).toBeFocused();
});

test('row editor preserves heading hierarchy', async ({ page }) => {
	await page.goto(`/vault/${VAULT_ID}`);
	await page.getByRole('button', { name: 'Open row detail' }).first().click();

	await expect(
		page.getByRole('heading', { name: 'card-a.md', level: 2 }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Frontmatter', level: 3 }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Body', level: 3 }),
	).toBeVisible();
});
