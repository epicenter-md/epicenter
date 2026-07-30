import type { SyncAuthClient } from '@epicenter/auth';

type ConnectionConfig = {
	baseURL: string;
	principalId: string;
	nodeId: string;
	openWebSocket: SyncAuthClient['openWebSocket'];
	onReconnectSignal: SyncAuthClient['onStateChange'];
};

/**
 * Project the boot-time auth snapshot into a workspace connection, the one
 * argument `model.connect()` takes (ADR-0088/ADR-0094):
 *
 * ```ts
 * return myAppWorkspace.connect(toConnection(auth, nodeId));
 * ```
 *
 * Signed out projects to `null` (the bare local-first wiring); any
 * identity-bearing state (signed in, reauth-required) projects to the principal's
 * connection coordinates. `baseURL` is constant across auth states
 * (one API per client). This reads `auth.state` ONCE: identity changes never
 * swap the connection in place, `reloadOnPrincipalChange` reloads so the next
 * boot re-projects.
 */
export function toConnection(
	auth: SyncAuthClient,
	nodeId: string,
): ConnectionConfig | null {
	const state = auth.state;
	if (state.status === 'signed-out') return null;
	return {
		baseURL: auth.deployment.baseURL,
		principalId: state.principalId,
		nodeId,
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
	};
}
