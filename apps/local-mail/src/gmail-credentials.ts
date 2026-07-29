import {
	type CredentialSource,
	type ProviderCredentialSpec,
	resolveProviderCredentials,
} from '@epicenter/constants/provider-credentials';
import { providerFilePath } from './paths.ts';
import {
	readProviderFile,
	writeProviderFileIfAbsent,
} from './provider-store.ts';

export type GmailCredentials = {
	clientId: string;
	clientSecret: string;
	source: 'distribution' | 'override';
};

/** The machine-wide BYO override (ADR-0188). */
export const GMAIL_SPEC = {
	prefix: 'GMAIL',
	environments: ['default'],
	environmentRoles: ['CLIENT_ID', 'CLIENT_SECRET'],
} as const satisfies ProviderCredentialSpec<'default'>;

/**
 * Private handoff from the native distribution shell to the Bun engine.
 * These are not operator-facing settings: a source build supplies GMAIL_*,
 * while a packaged distribution may compile its own identity into its shell.
 */
const DISTRIBUTION_GMAIL_SPEC = {
	prefix: 'LOCAL_MAIL_DISTRIBUTION_GMAIL',
	environments: ['default'],
	environmentRoles: ['CLIENT_ID', 'CLIENT_SECRET'],
} as const satisfies ProviderCredentialSpec<'default'>;

/**
 * Resolve one coherent client identity. An explicit machine override wins
 * whole; a partial override fails rather than borrowing the missing half from
 * the packaged distribution.
 */
export function resolveGmailCredentials(
	overrideRead: CredentialSource = (name) => process.env[name],
	distributionRead: CredentialSource = (name) => process.env[name],
): GmailCredentials {
	const hasOverride =
		overrideRead('GMAIL_CLIENT_ID') !== undefined ||
		overrideRead('GMAIL_CLIENT_SECRET') !== undefined;
	if (hasOverride) {
		const credentials = resolveProviderCredentials(
			GMAIL_SPEC,
			'default',
			overrideRead,
		);
		return {
			clientId: credentials.CLIENT_ID,
			clientSecret: credentials.CLIENT_SECRET,
			source: 'override',
		};
	}
	const hasDistributionIdentity =
		distributionRead('LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_ID') !== undefined ||
		distributionRead('LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_SECRET') !==
			undefined;
	if (!hasDistributionIdentity) {
		// Keep the source-build failure actionable. The distribution handoff is
		// private plumbing; a developer without it should supply the public BYO
		// names, not an internal shell-to-engine variable.
		resolveProviderCredentials(GMAIL_SPEC, 'default', overrideRead);
	}
	const credentials = resolveProviderCredentials(
		DISTRIBUTION_GMAIL_SPEC,
		'default',
		distributionRead,
	);
	return {
		clientId: credentials.CLIENT_ID,
		clientSecret: credentials.CLIENT_SECRET,
		source: 'distribution',
	};
}

/**
 * The machine-tier credential source: env wins per-name, then the 0600
 * provider.json at the data-dir root. Env stays the override/CI/test seam; the
 * file is the durable default every worktree shares.
 */
export function gmailCredentialSource(dataDir: string): CredentialSource {
	const file = readProviderFile(providerFilePath(dataDir));
	const envHasOverride =
		process.env.GMAIL_CLIENT_ID !== undefined ||
		process.env.GMAIL_CLIENT_SECRET !== undefined;
	return (name) => {
		if (envHasOverride) return process.env[name];
		const fromFile = file[name];
		return fromFile !== undefined && fromFile.length > 0 ? fromFile : undefined;
	};
}

/** Cache only an explicit override. A packaged default never becomes user state. */
export function persistGmailProviderCredentials(
	dataDir: string,
	creds: GmailCredentials,
): void {
	if (creds.source !== 'override') return;
	writeProviderFileIfAbsent(providerFilePath(dataDir), {
		GMAIL_CLIENT_ID: creds.clientId,
		GMAIL_CLIENT_SECRET: creds.clientSecret,
	});
}
