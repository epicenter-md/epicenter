import { redirect } from '@sveltejs/kit';
import * as rpc from '$lib/query';
import { assistantConfigs } from '$lib/stores/assistant-configs.svelte';

import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params }) => {
	const assistantConfig = assistantConfigs.getById(params.id);

	if (!assistantConfig) redirect(302, '/assistants');

	const { data: sessions, error } = await rpc.sessions
		.getSessions(() => assistantConfig)
		.ensure();

	if (error) redirect(302, '/assistants');

	return { assistantConfig, sessions };
};
