import { createContext } from 'svelte';
import type { WhisperingRpc } from '$lib/rpc';
import type { Recipes } from '$lib/state/recipes.svelte';
import type { Recordings } from '$lib/state/recordings.svelte';
import type { WhisperingApplication } from './application';

/**
 * The ready application as descendants of the fulfilled boot branch see it:
 * the UI-free product namespaces wrapped with Svelte dependency tracking.
 * Operation modules receive this explicitly; components read it from context.
 */
export type WhisperingApp = WhisperingApplication & {
	recordings: Recordings;
	recipes: Recipes;
};

export type WhisperingAppContext = WhisperingApp & { rpc: WhisperingRpc };

/**
 * Typed context supplied synchronously by `WhisperingAppProvider` inside the
 * fulfilled boot branch. `getWhisperingApp` is ready-only by construction:
 * nothing outside that branch can reach it.
 */
export const [getWhisperingApp, setWhisperingApp] =
	createContext<WhisperingAppContext>();
