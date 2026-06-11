/** @jsxImportSource hono/jsx */

import { CONSENT_SCRIPT } from './scripts/consent';

/**
 * Server-rendered OAuth consent page.
 *
 * Better Auth redirects here when a client application requests access to
 * the user's account. The page shows which application is requesting access,
 * the requested scopes, and approve/deny buttons.
 *
 * Query params (set by Better Auth):
 * - `client_id`: the requesting application
 * - `scope`: space-separated list of requested scopes
 */
export function ConsentPage({
	clientId,
	scope,
}: {
	clientId?: string;
	scope?: string;
}) {
	const scopes = scope ? scope.split(' ').filter(Boolean) : [];

	return (
		<>
			<h1>Authorize application</h1>
			<p class="subtitle">
				<span class="client-name">{clientId ?? 'An application'}</span> is
				requesting access to your Epicenter account.
			</p>

			{scopes.length > 0 && (
				<>
					<p>Requested permissions</p>
					<ul class="scope-list">
						{scopes.map((s) => (
							<li>{s}</li>
						))}
					</ul>
				</>
			)}

			<div id="msg" class="msg hidden" />

			<div class="actions">
				<button type="button" class="btn btn-primary" id="approve">
					Approve
				</button>
				<button type="button" class="btn btn-danger" id="deny">
					Deny
				</button>
			</div>

			{CONSENT_SCRIPT}
		</>
	);
}
