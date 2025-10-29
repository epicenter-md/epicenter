import type { RequestHandler } from '@sveltejs/kit';
import { getVault, jsonFormat } from '$lib/server/vaultService';

const json = (data: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(data), {
		headers: { 'content-type': 'application/json' },
		...init,
	});

export const GET: RequestHandler = async () => {
	try {
		const vault = getVault();
		const filesMap = await vault.exportData({ codec: jsonFormat });

		const files: Array<{ path: string; text: string; mimeType: string }> = [];
		for (const [path, file] of filesMap.entries()) {
			const text = await file.text();
			files.push({ path, text, mimeType: file.type || 'application/json' });
		}

		return json({ ok: true, files });
	} catch (err) {
		return json(
			{ ok: false, error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		);
	}
};
