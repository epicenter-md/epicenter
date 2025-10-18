import type { Accessor } from '@tanstack/svelte-query';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';

import { createAssistantClient } from '$lib/client/client.gen';
import * as api from '$lib/client/sdk.gen';
import type { PostSessionByIdMessageData } from '$lib/client/types.gen';
import { ShErr } from '$lib/result';
import type { AssistantConfig } from '$lib/stores/assistant-configs.svelte';

import { defineMutation, defineQuery } from './_client';

// Query for fetching messages by session ID
export const getMessagesBySessionId = (
	assistantConfig: Accessor<AssistantConfig>,
	sessionId: Accessor<string>,
) =>
	defineQuery({
		queryKey: [
			'assistants',
			assistantConfig().id,
			'sessions',
			sessionId(),
			'messages',
		],
		resultQueryFn: async () => {
			const client = createAssistantClient(assistantConfig());

			const { data, error } = await api.getSessionByIdMessage({
				client,
				path: { id: sessionId() },
			});

			if (error) {
				return ShErr({
					title: 'Failed to fetch messages',
					description: extractErrorMessage(error),
				});
			}

			return Ok(data);
		},
	});

// Mutation for sending a message
export const sendMessage = defineMutation({
	mutationKey: ['sendMessage'],
	resultMutationFn: async ({
		assistantConfig,
		body,
		sessionId,
	}: {
		assistantConfig: AssistantConfig;
		body: PostSessionByIdMessageData['body'];
		sessionId: string;
	}) => {
		const client = createAssistantClient(assistantConfig);

		// TODO: Provider and model should come from assistant settings or user preferences
		// For now, we'll use default values
		const { data, error } = await api.postSessionByIdMessage({
			body,
			client,
			path: { id: sessionId },
		});

		if (error) {
			return ShErr({
				title: 'Failed to send message',
				description: extractErrorMessage(error),
			});
		}
		return Ok(data);
	},
});
