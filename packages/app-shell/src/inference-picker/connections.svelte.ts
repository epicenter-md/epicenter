/**
 * The device-local inference connection registry (ADR-0059): one cohesive object
 * that owns the device's set of custom OpenAI-compatible connections plus the
 * model ids each was discovered to serve, and resolves a conversation's model to a
 * transport. Every chat app instantiates this once instead of re-deriving the same
 * persisted store, so the picker, the engine, and the cross-device banner all
 * read one source.
 *
 * Device-local, never synced: a key is a secret on the plaintext relay and a
 * `localhost` URL is meaningless elsewhere (ADR-0004). The arktype schema here is
 * the single runtime shape; `Connection` (from `@epicenter/client`) is the
 * matching compile-time type.
 *
 * Two axes people conflate. A custom connection here (a base URL + optional key)
 * is device-local and appears the moment it is added; it is unrelated to sign-in
 * or to which Epicenter instance is connected.
 *
 * The hosted entry is OPTIONAL, and an app must omit it when this device is not
 * bound to Epicenter Cloud. Its transport is the audience-scoped `auth.fetch`
 * (ADR-0053) against Cloud's gateway, while its base URL is Cloud's regardless of
 * the selected instance, so on a self-host session it would send an instance
 * bearer to Cloud and 401. A self-hosted instance serves no models of its own
 * either (ADR-0264), so there is nothing to substitute: the group simply does not
 * render, and every model comes from a device connection. Signed out of Cloud on a
 * hosted-default device, the entry is still passed and is shown-but-inert (the
 * chat surface's `onSignIn` catches the send).
 */

import {
	type Connection,
	createInferenceClient,
	type ListModelsError,
	type ResolvedConnection,
	resolveConnection,
} from '@epicenter/client';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import type { Result } from 'wellcrafted/result';

/**
 * A reactive persisted-state handle: localStorage (web) or chrome.storage
 * (extension). Both backends expose this identical `{ current }` interface, so
 * the registry binds against the shape and the app injects the mechanism.
 */
export type PersistedState<T> = { current: T };

/**
 * Builds one persisted slice from a key + schema + default value. The app
 * supplies the mechanism (web: `createPersistedState`; extension:
 * `createStorageState`), so `@epicenter/app-shell` depends on neither storage
 * backend.
 */
export type PersistFactory = <S extends StandardSchemaV1>(
	key: string,
	schema: S,
	defaultValue: StandardSchemaV1.InferOutput<S>,
) => PersistedState<StandardSchemaV1.InferOutput<S>>;

/**
 * One hosted catalog entry the app sells. Injected, not imported: the hosted
 * catalog is app-specific (Vocab offers a model the others do not), so the shared
 * registry never reaches into `@epicenter/constants`.
 */
export type HostedModel = { id: string; label: string };

/**
 * One stored custom connection: the transport identity (`baseUrl` + optional
 * `apiKey`) plus the model ids it was discovered to serve. A connection and its
 * models are one concept, so they live in one record (not two stores joined by
 * base URL); removing the connection drops its models with it. `models` is
 * optional so a connection persisted before this shape still loads, then
 * re-discovers on next open.
 */
const storedConnectionSchema = type({
	baseUrl: 'string',
	'apiKey?': 'string',
	'models?': 'string[]',
});
type StoredConnection = typeof storedConnectionSchema.infer;

/** The reactive registry object returned by {@link createInferenceConnections}. */
export type InferenceConnections = ReturnType<
	typeof createInferenceConnections
>;

export function createInferenceConnections({
	storageKey,
	hostedModels,
	hostedAlsoServes = [],
	hosted,
	persist,
}: {
	/** Namespace for the persisted-state keys, e.g. the app name. */
	storageKey: string;
	/** The hosted catalog this app sells (app-specific subset). Ignored when
	 *  `hosted` is omitted, since those ids would have no transport. */
	hostedModels: HostedModel[];
	/**
	 * Further ids the hosted transport serves that are NOT offered in the picker,
	 * typically STT models: one Connection base drives both `/chat/completions` and
	 * `/audio/transcriptions` (ADR-0060), so Cloud serves `whisper-1` on the same
	 * transport without it being a chat model anyone picks. Declaring it here is
	 * what lets `resolve('whisper-1')` find the hosted transport; without it the
	 * id would resolve to nothing.
	 */
	hostedAlsoServes?: readonly string[];
	/**
	 * The hosted transport (`auth.fetch` + Cloud's gateway base URL). Omit it when
	 * this device is not bound to Epicenter Cloud (`instanceSetting.isDefault()` is
	 * false): the credential would be the wrong audience for that URL. With it
	 * omitted, `hostedModels` reads empty and the picker's Epicenter group does not
	 * render.
	 */
	hosted?: ResolvedConnection;
	/** The persistence mechanism (web: localStorage; extension: chrome.storage). */
	persist: PersistFactory;
}) {
	const stored = persist(
		`${storageKey}.inference-connections`,
		storedConnectionSchema.array(),
		[],
	);

	/** The candidates a model resolves against, in priority order: every custom
	 * connection (the user's own key) BEFORE hosted. The hosted catalog sells real
	 * upstream ids (e.g. `gpt-5.5`), so a user who adds their own OpenAI key serves a
	 * colliding id; matching custom first resolves that turn to the user's key
	 * instead of silently metering it against Epicenter credits. Hosted is the last
	 * resort, serving only ids no custom connection on this device claims.
	 *
	 * Each candidate carries its own `resolve` thunk, so matching never branches on
	 * what a candidate is: a custom connection closes over `resolveConnection`
	 * (static data -> transport); hosted closes over the injected transport. The
	 * `kind` discriminant is gone (ADR-0060). */
	function candidates(): {
		resolve: () => ResolvedConnection;
		models: readonly string[];
	}[] {
		return [
			...stored.current.map((connection) => ({
				resolve: () => resolveConnection(connection),
				models: connection.models ?? [],
			})),
			// Only when this device has a hosted transport; otherwise Cloud's ids are
			// not offered at all rather than offered and unreachable.
			...(hosted
				? [
						{
							resolve: () => hosted,
							models: [...hostedModels.map((m) => m.id), ...hostedAlsoServes],
						},
					]
				: []),
		];
	}

	/** Resolve a conversation's model (ADR-0055) to its transport, or `null` when no
	 * connection on this device serves it. One definition of the served/unserved
	 * predicate, exposed as `resolve` (transport) and `canServe` (boolean) so
	 * neither the engine nor the UI re-derives it. */
	function resolve(model: string): ResolvedConnection | null {
		return (
			candidates()
				.find((c) => c.models.includes(model))
				?.resolve() ?? null
		);
	}

	return {
		/** The hosted catalog this app sells (for the picker's Epicenter group).
		 *  Empty when no hosted transport was supplied, which is what removes the
		 *  group from the picker. */
		hostedModels: hosted ? hostedModels : [],
		/**
		 * The device's custom connections, in display order. Each carries its own
		 * discovered `models` (see {@link StoredConnection}), so the picker reads one
		 * list instead of joining a connection to a separate models map by base URL.
		 */
		get custom(): readonly StoredConnection[] {
			return stored.current;
		},

		/** Add (or replace by base URL) a connection, optionally caching its models. */
		add(connection: Connection, models?: string[]) {
			const existing = stored.current.find(
				(c) => c.baseUrl === connection.baseUrl,
			);
			stored.current = [
				...stored.current.filter((c) => c.baseUrl !== connection.baseUrl),
				{ ...connection, models: models ?? existing?.models ?? [] },
			];
		},
		/** Forget a connection and its discovered models by base URL. */
		remove(baseUrl: string) {
			stored.current = stored.current.filter((c) => c.baseUrl !== baseUrl);
		},

		/** Discover the models a candidate endpoint serves (best effort, never throws). */
		discover(
			baseUrl: string,
			apiKey?: string,
		): Promise<Result<string[], ListModelsError>> {
			return createInferenceClient(
				resolveConnection({ baseUrl, apiKey: apiKey || undefined }),
			).listModels();
		},

		/** Re-discover an already-added connection's models and update its cached
		 * list, for when a user pulled a new model at the endpoint after connecting.
		 * Best effort by design: on failure the previously discovered ids stand, so a
		 * transient outage never empties the group, and nothing is returned because the
		 * caller has nothing to surface (unlike `discover`, whose error builds the
		 * connect-form hint). Connect-time `add` still owns first discovery; this is the
		 * one path that refreshes a stale list in place. */
		async refresh(baseUrl: string): Promise<void> {
			const connection = stored.current.find((c) => c.baseUrl === baseUrl);
			if (!connection) return;
			const { data, error } = await createInferenceClient(
				resolveConnection(connection),
			).listModels();
			if (error) return;
			stored.current = stored.current.map((c) =>
				c.baseUrl === baseUrl ? { ...c, models: data } : c,
			);
		},

		/**
		 * The transport for a conversation's model, or `null` when nothing on this
		 * device serves it. It never substitutes a different model and never falls
		 * back to a transport the model does not belong to: with no hosted entry
		 * there is nothing to fall back to, and with one, sending an unservable id to
		 * Cloud only buys a loud error. Callers gate sending via {@link canServe}, so
		 * `null` is the already-blocked path.
		 */
		resolve,
		/**
		 * Whether a connection on this device serves the model. The single predicate
		 * behind both the cross-device banner and the send gate; never rewrites the
		 * synced model column.
		 */
		canServe(model: string): boolean {
			return resolve(model) !== null;
		},
	};
}
