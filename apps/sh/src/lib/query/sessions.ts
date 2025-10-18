import type { Accessor } from '@tanstack/svelte-query';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';

import { createAssistantClient } from '$lib/client/client.gen';
import * as api from '$lib/client/sdk.gen';
import type { PostSessionByIdSummarizeData } from '$lib/client/types.gen';
import { ShErr } from '$lib/result';
import type { AssistantConfig } from '$lib/stores/assistant-configs.svelte';

import { defineMutation, defineQuery, queryClient } from './_client';

// Query for fetching all sessions in an assistant
export const getSessions = (assistantConfig: Accessor<AssistantConfig>) =>
	defineQuery({
		queryKey: ['assistants', assistantConfig().id, 'sessions'],
		resultQueryFn: async () => {
			const client = createAssistantClient(assistantConfig());

			const { data, error } = await api.getSession({ client });
			if (error) {
				return ShErr({
					title: 'Failed to fetch sessions',
					description: extractErrorMessage(error),
				});
			}

			return Ok(data);
		},
	});

// Mutation for creating a new session
export const createSession = defineMutation({
	mutationKey: ['createSession'],
	onSuccess: (_, { assistantConfig }) => {
		queryClient.invalidateQueries({
			queryKey: ['assistants', assistantConfig.id, 'sessions'],
		});
	},
	resultMutationFn: async ({
		assistantConfig,
	}: {
		assistantConfig: AssistantConfig;
	}) => {
		const client = createAssistantClient(assistantConfig);

		const { data: session, error } = await api.postSession({ client });
		if (error) {
			return ShErr({
				title: 'Failed to create session',
				description: extractErrorMessage(error),
			});
		}
		return Ok(session);
	},
});

// Mutation for deleting a session
export const deleteSession = defineMutation({
	mutationKey: ['deleteSession'],
	onSuccess: (_, { assistantConfig }) => {
		queryClient.invalidateQueries({
			queryKey: ['assistants', assistantConfig.id, 'sessions'],
		});
	},
	resultMutationFn: async ({
		assistantConfig,
		sessionId,
	}: {
		assistantConfig: AssistantConfig;
		sessionId: string;
	}) => {
		const client = createAssistantClient(assistantConfig);

		const { data, error } = await api.deleteSessionById({
			client,
			path: { id: sessionId },
		});
		if (error) {
			return ShErr({
				title: 'Failed to delete session',
				description: extractErrorMessage(error),
			});
		}
		return Ok(data);
	},
});

// Mutation for sharing a session
export const shareSession = defineMutation({
	mutationKey: ['shareSession'],
	onSuccess: (_, { assistantConfig }) => {
		queryClient.invalidateQueries({
			queryKey: ['assistants', assistantConfig.id, 'sessions'],
		});
	},
	resultMutationFn: async ({
		assistantConfig,
		sessionId,
	}: {
		assistantConfig: AssistantConfig;
		sessionId: string;
	}) => {
		const client = createAssistantClient(assistantConfig);

		const { data, error } = await api.postSessionByIdShare({
			client,
			path: { id: sessionId },
		});
		if (error) {
			return ShErr({
				title: 'Failed to share session',
				description: extractErrorMessage(error),
			});
		}
		return Ok(data);
	},
});

// Mutation for unsharing a session
export const unshareSession = defineMutation({
	mutationKey: ['unshareSession'],
	onSuccess: (_, { assistantConfig }) => {
		queryClient.invalidateQueries({
			queryKey: ['assistants', assistantConfig.id, 'sessions'],
		});
	},
	resultMutationFn: async ({
		assistantConfig,
		sessionId,
	}: {
		assistantConfig: AssistantConfig;
		sessionId: string;
	}) => {
		const client = createAssistantClient(assistantConfig);

		const { data, error } = await api.deleteSessionByIdShare({
			client,
			path: { id: sessionId },
		});
		if (error) {
			return ShErr({
				title: 'Failed to unshare session',
				description: extractErrorMessage(error),
			});
		}
		return Ok(data);
	},
});

// Mutation for aborting a session
export const abortSession = defineMutation({
	mutationKey: ['abortSession'],
	onSuccess: (_, { assistantConfig }) => {
		queryClient.invalidateQueries({
			queryKey: ['assistants', assistantConfig.id, 'sessions'],
		});
	},
	resultMutationFn: async ({
		assistantConfig,
		sessionId,
	}: {
		assistantConfig: AssistantConfig;
		sessionId: string;
	}) => {
		const client = createAssistantClient(assistantConfig);

		const { data, error } = await api.postSessionByIdAbort({
			client,
			path: { id: sessionId },
		});
		if (error) {
			return ShErr({
				title: 'Failed to abort session',
				description: extractErrorMessage(error),
			});
		}
		return Ok(data);
	},
});

// Mutation for initializing a session
export const initializeSession = defineMutation({
	mutationKey: ['initializeSession'],
	onSuccess: (_, { assistantConfig }) => {
		queryClient.invalidateQueries({
			queryKey: ['assistants', assistantConfig.id, 'sessions'],
		});
	},
	resultMutationFn: async ({
		assistantConfig,
		body,
		sessionId,
	}: {
		assistantConfig: AssistantConfig;
		body?: { messageID: string; modelID: string; providerID: string };
		sessionId: string;
	}) => {
		const client = createAssistantClient(assistantConfig);

		const { data, error } = await api.postSessionByIdInit({
			body,
			client,
			path: { id: sessionId },
		});
		if (error) {
			return ShErr({
				title: 'Failed to initialize session',
				description: extractErrorMessage(error),
			});
		}
		return Ok(data);
	},
});

// Mutation for summarizing a session
export const summarizeSession = defineMutation({
	mutationKey: ['summarizeSession'],
	onSuccess: (_, { assistantConfig }) => {
		queryClient.invalidateQueries({
			queryKey: ['assistants', assistantConfig.id, 'sessions'],
		});
	},
	resultMutationFn: async ({
		assistantConfig,
		body,
		sessionId,
	}: {
		assistantConfig: AssistantConfig;
		body: PostSessionByIdSummarizeData['body'];
		sessionId: string;
	}) => {
		const client = createAssistantClient(assistantConfig);

		const { data, error } = await api.postSessionByIdSummarize({
			body,
			client,
			path: { id: sessionId },
		});
		if (error) {
			return ShErr({
				title: 'Failed to summarize session',
				description: extractErrorMessage(error),
			});
		}
		return Ok(data);
	},
});

// Query for fetching a single session by ID
export const getSessionById = (
	assistantConfig: Accessor<AssistantConfig>,
	sessionId: Accessor<string>,
) =>
	defineQuery({
		queryKey: ['assistants', assistantConfig().id, 'sessions'],
		resultQueryFn: async () => {
			const client = createAssistantClient(assistantConfig());

			const { data, error } = await api.getSession({ client });
			if (error) {
				return ShErr({
					title: 'Failed to fetch sessions',
					description: extractErrorMessage(error),
				});
			}

			return Ok(data);
		},
		select: (sessions) => sessions?.find((s) => s.id === sessionId()),
	});
