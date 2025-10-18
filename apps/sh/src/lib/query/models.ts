import type { Accessor } from '@tanstack/svelte-query';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { createAssistantClient } from '$lib/client/client.gen';
import * as api from '$lib/client/sdk.gen';
import { ShErr } from '$lib/result';
import type { AssistantConfig } from '$lib/stores/assistant-configs.svelte';

import { defineQuery } from './_client';

// Query for fetching all providers and models
export const getProviders = (assistant: Accessor<AssistantConfig>) =>
	defineQuery({
		queryKey: ['assistants', assistant().id, 'providers'],
		resultQueryFn: async () => {
			const client = createAssistantClient(assistant());

			const { data, error } = await api.getConfigProviders({ client });
			if (error) {
				return ShErr({
					title: 'Failed to fetch providers',
					description: extractErrorMessage(error),
				});
			}

			return Ok(data);
		},
	});
