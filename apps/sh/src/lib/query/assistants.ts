import type { Accessor } from '@tanstack/svelte-query';
import { Ok } from 'wellcrafted/result';
import { createAssistantClient } from '$lib/client/client.gen';
import * as api from '$lib/client/sdk.gen';
import type { App } from '$lib/client/types.gen';
import type { AssistantConfig } from '$lib/stores/assistant-configs.svelte';

import { defineQuery } from './_client';

/**
 * An assistant configuration merged with live OpenCode app information.
 *
 * This type represents the result of attempting to connect to an assistant's OpenCode server:
 * - If the connection succeeds (connected=true): includes the full OpenCode app info
 * - If the connection fails (connected=false): assistant is unreachable
 * - Always includes checkedAt: timestamp of when we last checked the connection
 *
 * Used in the UI to show users which assistants are currently online and available.
 */
export type Assistant = AssistantConfig &
	({ appInfo: App; connected: true } | { connected: false }) & {
		checkedAt: string; // ISO timestamp of last connection check
	};

/**
 * Fetches a single assistant config and attempts to merge it with live OpenCode app information.
 *
 * Takes an assistant config and:
 * - Attempts to connect to its OpenCode server using the assistant URL
 * - If connection succeeds: marks connected=true and includes the OpenCode app info
 * - If connection fails: marks connected=false (assistant unreachable)
 *
 * Used in the UI to show whether a specific assistant is online and available.
 *
 * @param config - The assistant configuration to check connection status for
 * @returns The assistant with connection status and app info (if connected)
 */
export const getAssistant = (config: Accessor<AssistantConfig>) =>
	defineQuery({
		queryKey: ['assistant', config().id],
		resultQueryFn: async (): Promise<Ok<Assistant>> => {
			const client = createAssistantClient(config());

			const { data, error } = await api.getApp({ client });

			if (data && !error) {
				return Ok({
					...config(),
					appInfo: data,
					checkedAt: new Date().toISOString(),
					connected: true,
				});
			}

			return Ok({
				...config(),
				checkedAt: new Date().toISOString(),
				connected: false,
			});
		},
		// TanStack Query default behavior:
		// - retry: 3 (retries failed queries 3 times with exponential backoff)
		// - retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000)
		//   This means: 1s, 2s, 4s, 8s... up to 30s between retries
		//
		// Why we override to retry: 0:
		// - Retrying won't fix a non-existent domain or closed tunnel
		// - Each retry generates console errors, creating noise
		retry: 0,

		// TanStack Query default: retryOnMount: true
		// This means when a component remounts, it retries failed queries
		// We set retryOnMount: false to prevent retry spam when navigating between pages
		retryOnMount: false,
	});
