/**
 * One labeled secret per application account, held in the OS credential store.
 *
 * Epicenter does not know what a Gmail refresh token is. It knows how to hold
 * one opaque value under a label, scoped to the application that stored it
 * (ADR-0310). There is no `list`: an application already records its accounts
 * in its own data, so nothing has to ask the credential store who it is.
 *
 * **Bun never names a keyring entry.** It sends the application id and the
 * label, both already validated at the route, and Rust composes the
 * service and account strings it stores under. That keeps the private sidecar
 * pipe as content-blind as it was when it carried only the auth cell: the worst
 * a compromised Bun can address here is a different application's secret, which
 * every SPA on this trusted origin could already ask for directly (ADR-0118).
 *
 * The namespace is for collision, not protection. Two applications each naming
 * a token `gmail` is a bug that silently syncs the wrong mailbox; it is not a
 * sandbox and must not be described as one.
 */

export type AppSecretOwner = {
	put(appId: string, label: string, value: string): Promise<void>;
	get(appId: string, label: string): Promise<string | null>;
	delete(appId: string, label: string): Promise<void>;
};

/** The native half of this owner: three correlated requests on the Rust pipe. */
export type NativeSecretPort = {
	putAppSecret(appId: string, label: string, value: string): Promise<void>;
	getAppSecret(appId: string, label: string): Promise<string | null>;
	deleteAppSecret(appId: string, label: string): Promise<void>;
};

export function createNativeAppSecrets(port: NativeSecretPort): AppSecretOwner {
	return {
		put: (appId, label, value) => port.putAppSecret(appId, label, value),
		get: (appId, label) => port.getAppSecret(appId, label),
		delete: (appId, label) => port.deleteAppSecret(appId, label),
	};
}

/**
 * A secret owner for a host running without its Rust parent: the server tests,
 * and the bare Bun run an operator uses to exercise the origin alone.
 *
 * It forgets everything when the process ends, which is the honest behavior for
 * a run with no credential store attached. It is not a fallback the desktop
 * release can reach: the composition root binds the native owner whenever the
 * pipe is there, and no environment variable selects this one.
 */
export function createProcessMemoryAppSecrets(): AppSecretOwner {
	const values = new Map<string, string>();
	const key = (appId: string, label: string) => `${appId} ${label}`;
	return {
		async put(appId, label, value) {
			values.set(key(appId, label), value);
		},
		async get(appId, label) {
			return values.get(key(appId, label)) ?? null;
		},
		async delete(appId, label) {
			values.delete(key(appId, label));
		},
	};
}
