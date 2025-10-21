import type { Adapter } from '@repo/vault-core';
import { entityIndexAdapter } from '@repo/vault-core/adapters/entity-index';
import { exampleNotesAdapter } from '@repo/vault-core/adapters/example-notes';
import { redditAdapter } from '@repo/vault-core/adapters/reddit';
import type { RequestHandler } from '@sveltejs/kit';
import { getTableCounts, getVault } from '$lib/server/vaultService';

const json = (data: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(data), {
		headers: { 'content-type': 'application/json' },
		...init,
	});

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		const adapterId = url.searchParams.get('adapter');
		if (!adapterId)
			return json(
				{ ok: false, error: 'adapter query param required' },
				{ status: 400 },
			);

		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File))
			return json({ ok: false, error: 'file missing' }, { status: 400 });

		const factories: Record<string, () => Adapter> = {
			reddit: redditAdapter,
			entity_index: entityIndexAdapter,
			example_notes: exampleNotesAdapter,
		};
		const factory = factories[adapterId];
		if (!factory)
			return json(
				{ ok: false, error: `unknown adapter '${adapterId}'` },
				{ status: 400 },
			);

		const adapter = factory();

		const vault = getVault();
		await vault.ingestData({ adapter, file });

		const counts = await getTableCounts();
		return json({ ok: true, counts });
	} catch (err) {
		return json(
			{ ok: false, error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		);
	}
};
