import type { RequestHandler } from '@sveltejs/kit';
import { getVault, jsonFormat } from '$lib/server/vaultService';

const json = (data: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(data), {
		headers: { 'content-type': 'application/json' },
		...init,
	});

type ImportFile = { path: string; text: string; mimeType?: string };
type ImportBody = { files: ImportFile[] };

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as Partial<ImportBody>;
		const filesInput = body?.files;
		if (!Array.isArray(filesInput)) {
			return json(
				{ ok: false, error: 'files array required' },
				{ status: 400 },
			);
		}

		const files = new Map<string, File>();
		for (const f of filesInput) {
			if (!f || typeof f.path !== 'string' || typeof f.text !== 'string')
				continue;
			const filename = f.path.split('/').pop() || 'file.json';
			const file = new File([f.text], filename, {
				type: f.mimeType ?? 'application/json',
			});
			files.set(f.path, file);
		}

		await getVault().importData({ files, codec: jsonFormat });
		return json({ ok: true });
	} catch (err) {
		return json(
			{ ok: false, error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		);
	}
};
