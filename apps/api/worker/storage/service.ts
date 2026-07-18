/**
 * Hosted first-contact storage admission (ADR-0137).
 *
 * The route calls this policy only for an unknown replica. A refusal leaves the
 * push undispatched. Admission refreshes the account's structured observation,
 * preserves blob accounting, and registers a newly admitted workspace at zero
 * bytes before its first push creates durable authority state.
 */

import type { PrincipalId } from '@epicenter/identity';
import type { StorageObservation } from '@epicenter/server';
import { extractErrorMessage } from 'wellcrafted/error';

export type StorageAdmissionTarget = {
	principalId: PrincipalId;
	workspaceId: string;
};

export type StorageAdmissionDependencies = {
	listObservations(): Promise<StorageObservation[]>;
	/** The already-resolved account authority's physical size. */
	readAccountBytes(): Promise<number>;
	upsertObservation(
		observation: StorageObservation & { principalId: PrincipalId },
	): Promise<void>;
	resolveIncludedBytes(): Promise<number>;
	reportError?(message: string): void;
};

export type RegisteredStorageAdmissionDependencies = Pick<
	StorageAdmissionDependencies,
	'listObservations' | 'reportError'
>;

/** Allow first contact only for a workspace already known to hosted storage. */
export async function admitRegisteredStorageFirstContact(
	{
		listObservations,
		reportError = console.error,
	}: RegisteredStorageAdmissionDependencies,
	target: StorageAdmissionTarget,
): Promise<'allow' | 'refuse'> {
	try {
		const observations = await listObservations();
		return observations.some(
			(observation) =>
				observation.sourceKind === 'workspace' &&
				observation.sourceId === target.workspaceId,
		)
			? 'allow'
			: 'refuse';
	} catch (cause) {
		reportError(
			`[storage] first-contact admission for ${target.principalId}/${target.workspaceId} failed: ${extractErrorMessage(cause)}`,
		);
		return 'refuse';
	}
}

/** Evaluate and register one hosted workspace before its first replica push. */
export async function admitStorageFirstContact(
	{
		listObservations,
		readAccountBytes,
		upsertObservation,
		resolveIncludedBytes,
		reportError = console.error,
	}: StorageAdmissionDependencies,
	target: StorageAdmissionTarget,
): Promise<'allow' | 'refuse'> {
	try {
		const observations = await listObservations();
		const registeredWorkspaceIds = new Set(
			observations
				.filter((observation) => observation.sourceKind === 'workspace')
				.map((observation) => observation.sourceId),
		);
		const blobBytes = observations
			.filter((observation) => observation.sourceKind === 'blobs')
			.reduce((sum, observation) => sum + observation.observedBytes, 0);
		const accountBytes = await readAccountBytes();
		await upsertObservation({
			principalId: target.principalId,
			sourceKind: 'structured',
			sourceId: 'account',
			observedBytes: accountBytes,
		});

		if (blobBytes + accountBytes >= (await resolveIncludedBytes())) {
			return 'refuse';
		}

		if (!registeredWorkspaceIds.has(target.workspaceId)) {
			await upsertObservation({
				principalId: target.principalId,
				sourceKind: 'workspace',
				sourceId: target.workspaceId,
				observedBytes: 0,
			});
		}
		return 'allow';
	} catch (cause) {
		reportError(
			`[storage] first-contact admission for ${target.principalId}/${target.workspaceId} failed: ${extractErrorMessage(cause)}`,
		);
		return 'refuse';
	}
}
