import { exportZip } from '$lib/export';

export const GET = async () => {
	const zipped = await exportZip();
	// @ts-expect-error @types/node, I want to throw you in the sun
	return new Response(zipped.buffer, {
		headers: {
			'Content-Type': 'application/zip',
			'Content-Disposition': 'attachment; filename="vault-export.zip"',
		},
	});
};
