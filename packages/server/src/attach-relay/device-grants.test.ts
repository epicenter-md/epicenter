/**
 * Device-grant store proof (ADR-0115 wave 3): mint, resolve, revoke.
 *
 * What this pins at the unit level (the attach mount's E2E is in
 * `apps/epicenter/src/attach-relay-self-host.test.ts`):
 * - a minted grant resolves to the one instance principal;
 * - a never-minted bearer and a revoked grant both resolve to `InvalidToken`
 *   (fail closed), so revocation kills the next connect;
 * - the raw secret is returned once and never surfaces in `list`;
 * - one device's revocation leaves every other grant live.
 */

import { describe, expect, test } from 'bun:test';
import { INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import { createDeviceGrantStore } from './device-grants.js';

/** A throwaway context; the grant resolver never reads it. */
const noContext = {} as never;

describe('device-grant store', () => {
	test('a minted grant resolves to the instance principal', async () => {
		const grants = createDeviceGrantStore();
		const { token } = await grants.mint({ deviceId: 'phone', label: 'Phone' });

		const { data, error } = await grants.resolveBearerPrincipal(
			noContext,
			token,
		);
		expect(error).toBeNull();
		expect(data?.id).toBe(INSTANCE_PRINCIPAL_ID);
	});

	test('a never-minted bearer fails closed', async () => {
		const grants = createDeviceGrantStore();
		await grants.mint({ deviceId: 'phone' });

		const { data, error } = await grants.resolveBearerPrincipal(
			noContext,
			'never-minted-token',
		);
		expect(data).toBeNull();
		expect(error).not.toBeNull();
	});

	test('revoking a grant kills its next resolve', async () => {
		const grants = createDeviceGrantStore();
		const grant = await grants.mint({ deviceId: 'phone' });

		expect(
			(await grants.resolveBearerPrincipal(noContext, grant.token)).error,
		).toBeNull();

		expect(grants.revoke(grant.id)).toBe(true);

		const { data, error } = await grants.resolveBearerPrincipal(
			noContext,
			grant.token,
		);
		expect(data).toBeNull();
		expect(error).not.toBeNull();
		// Revoking a gone grant is a no-op, never a throw.
		expect(grants.revoke(grant.id)).toBe(false);
	});

	test('the secret is returned once and never listed', async () => {
		const grants = createDeviceGrantStore();
		const grant = await grants.mint({ deviceId: 'phone', label: 'Phone' });

		const listed = grants.list();
		expect(listed).toHaveLength(1);
		const entry = listed[0];
		expect(entry?.id).toBe(grant.id);
		expect(entry?.deviceId).toBe('phone');
		expect(entry?.label).toBe('Phone');
		// No secret leaks into the list view.
		expect(Object.keys(entry ?? {})).not.toContain('token');
	});

	test('revoking one device leaves the others live', async () => {
		const grants = createDeviceGrantStore();
		const phone = await grants.mint({ deviceId: 'phone' });
		const laptop = await grants.mint({ deviceId: 'laptop' });

		grants.revoke(phone.id);

		expect(
			(await grants.resolveBearerPrincipal(noContext, phone.token)).error,
		).not.toBeNull();
		expect(
			(await grants.resolveBearerPrincipal(noContext, laptop.token)).error,
		).toBeNull();
		expect(grants.list().map((g) => g.deviceId)).toEqual(['laptop']);
	});
});
