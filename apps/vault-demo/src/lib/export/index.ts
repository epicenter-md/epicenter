import { ZIP } from '@repo/vault-core/utils/archive/zip';
import { getVault, jsonFormat } from '$lib/server/vaultService';

export const exportZip = async () => {
	const vault = getVault();
	const filesMap = await vault.exportData({ codec: jsonFormat });
	const all = await Promise.all(
		filesMap
			.entries()
			.map(async ([path, file]) => [path, await file.bytes()] as const),
	);
	const rec = Object.fromEntries(all);
	const zipped = await ZIP.pack(rec);
	return zipped;
};
