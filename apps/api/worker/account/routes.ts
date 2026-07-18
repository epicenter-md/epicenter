/**
 * Hosted account deletion: `DELETE /api/account`.
 *
 * The route owns HTTP shape and wiring; `service.ts` owns the retry-safe
 * step order. A partial failure answers 503 with the failed step; deletion is
 * complete only when the route answers 204. Known non-atomic residue,
 * accepted: a presigned blob PUT issued up to five minutes earlier can land
 * after the prefix sweep, and the deleting browser's encrypted session cookie
 * cache can outlive the user row by up to five minutes (bearer requests
 * re-read the user row and fail immediately).
 *
 * Lives in apps/api, not @epicenter/server: Better Auth, Postgres, and Autumn
 * are hosted-only deployment policy. The self-hosted instance has no per-user
 * account; its analog would be an operator-owned whole-instance reset, which
 * deliberately does not exist as an HTTP surface.
 */

import {
	blobPrincipalPrefix,
	type CloudEnv,
	createDurableObjectAccountAuthorities,
	deleteStorageObservations,
	resolveDeploymentBlobStore,
} from '@epicenter/server';
import {
	deleteHostedPrincipal,
	readHostedPrincipalEmail,
} from '@epicenter/server/cloud-db';
import type { Hono, MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import { extractErrorMessage } from 'wellcrafted/error';
import { createBillingService } from '../billing/service.js';
import { runAccountDeletion } from './service.js';

/**
 * Mount the hosted account-deletion route. Auth is bundled so the destructive
 * surface cannot be mounted without it; the dashboard reaches it with its
 * host-only session cookie and confirms destructive intent in its own UI.
 */
export function mountAccountDeletionApi(
	app: Hono<CloudEnv>,
	opts: { auth: MiddlewareHandler },
): void {
	app.delete(
		'/api/account',
		describeRoute({
			description:
				'Delete the authenticated account everywhere: authority storage, blobs, billing customer, storage observations, and the auth user. Retry until 204.',
			tags: ['account'],
		}),
		opts.auth,
		async (c) => {
			const principalId = c.var.principal.id;
			const result = await runAccountDeletion(
				{
					authority: () =>
						createDurableObjectAccountAuthorities(
							(c.env as Cloudflare.Env).RECORDS,
						)
							.authority(principalId)
							.deleteAccount(),
					async blobs() {
						const store = resolveDeploymentBlobStore(c.env);
						if (store) {
							await store.deletePrefix(blobPrincipalPrefix(principalId));
						}
					},
					async billing() {
						const principalEmail = await readHostedPrincipalEmail(
							c.var.db,
							principalId,
						);
						// A missing user row means an earlier attempt already got past
						// the auth-user step; there is no billing identity left to clean.
						if (principalEmail === null) return;
						const { error } = await createBillingService(
							c.env as Cloudflare.Env,
							{ principalId, principalEmail },
						).deleteCustomer();
						if (error) throw new Error(extractErrorMessage(error));
					},
					observations: () => deleteStorageObservations(c.var.db, principalId),
					'auth-user': () => deleteHostedPrincipal(c.var.db, principalId),
				},
				principalId,
			);
			if (result.outcome === 'incomplete') {
				return c.json(
					{
						error: {
							name: 'AccountDeletionIncomplete',
							message: `Account deletion did not complete (step: ${result.failedStep}). Retry the request.`,
							failedStep: result.failedStep,
						},
					},
					503,
				);
			}
			return c.body(null, 204);
		},
	);
}
