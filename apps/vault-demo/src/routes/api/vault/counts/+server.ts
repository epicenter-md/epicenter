import type { RequestHandler } from '@sveltejs/kit';
import { getTableCounts } from '$lib/server/vaultService';

const json = (data: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(data), {
		headers: { 'content-type': 'application/json' },
		...init,
	});

export const GET: RequestHandler = async () => {
	try {
		const counts = await getTableCounts();
		return json({ ok: true, counts });
	} catch (err) {
		return json(
			{ ok: false, error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		);
	}
};
