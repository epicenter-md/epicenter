/**
 * Reactive tool-trust state: which AI chat tools auto-approve.
 *
 * The table is a presence set (see `$lib/workspace`): a row means "always
 * allow", no row means ask. Query tools never consult this; they run unattended
 * either way. Grants sync across devices like any other row.
 *
 * A grant is matched by `toolName`, not by row id, because row ids are
 * runtime-minted (ADR-0187). Revoking deletes every row naming that tool, so two
 * devices that granted the same tool concurrently both get revoked by one click.
 */

import { fromTable } from '@epicenter/svelte';
import type { TabManagerData } from '$lib/workspace';

export function createToolTrustState({ data }: { data: TabManagerData }) {
	const trustView = fromTable(data.tables.toolTrust);

	/** Tool names with a live grant, deduplicated and stable per change. */
	const trustedNames = $derived([
		...new Set(trustView.all.map((grant) => grant.toolName)),
	]);

	return {
		/** Resolves once the first read of this table has landed. */
		whenReady: trustView.whenReady,

		/**
		 * Whether a tool auto-approves without showing the approval UI.
		 *
		 * Honors only a grant this binary can read: a row written by a newer
		 * binary is nonconforming here, so it falls back to the safe "ask"
		 * default rather than auto-approving a row whose fields it cannot see.
		 */
		shouldAutoApprove(name: string): boolean {
			return trustedNames.includes(name);
		},

		/** Auto-approve this tool from now on (the "Always Allow" action). */
		async allow(name: string): Promise<void> {
			if (trustedNames.includes(name)) return;
			await data.tables.toolTrust.create({ toolName: name });
		},

		/** Return this tool to the ask-every-time default. */
		async revoke(name: string): Promise<void> {
			// Snapshot the matching row ids before the first await. `all` is a live
			// reactive read that each delete invalidates, so iterating it directly
			// would be walking a list that changes underneath the loop.
			const revoking = trustView.all
				.filter((grant) => grant.toolName === name)
				.map((grant) => grant.id);
			for (const id of revoking) await data.tables.toolTrust.delete(id);
		},

		/** Every auto-approved tool name. */
		get trustedToolNames(): readonly string[] {
			return trustedNames;
		},
	};
}
