/** Focused proof that a Bun-served trusted page has native Epicenter authority. */

import { invoke, isTauri } from '@tauri-apps/api/core';

export type RuntimeInfo = {
	product: 'Epicenter';
	origin: string;
};

export async function readRuntimeInfo(): Promise<RuntimeInfo | null> {
	if (!isTauri()) return null;
	return invoke<RuntimeInfo>('get_runtime_info');
}
