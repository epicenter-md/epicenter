/**
 * Hosted storage capability issuance (ADR-0137).
 *
 * The observation registry is the complete set of storage-producing sources
 * already issued to an account. Enrollment refreshes only those registered
 * workspace authorities before deciding. An unseen target is not contacted
 * or registered on refusal. Once admitted, the source is registered at zero
 * bytes and only then is its first replica minted. A later issuance refreshes
 * that registered authority's absolute size. Synchronization never consults or
 * mutates this policy.
 */

import type { PrincipalId } from '@epicenter/identity';
import type {
	Records,
	RecordsPartition,
	StorageObservation,
} from '@epicenter/server';
import { extractErrorMessage } from 'wellcrafted/error';

export type EnrollmentResponse = Awaited<ReturnType<Records['enroll']>>;

export type StorageIssuanceDependencies = {
	listObservations(principalId: PrincipalId): Promise<StorageObservation[]>;
	readWorkspaceBytes(partition: RecordsPartition): Promise<number>;
	upsertObservation(
		observation: StorageObservation & { principalId: PrincipalId },
	): Promise<void>;
	resolveIncludedBytes(): Promise<number>;
	reportError?(message: string): void;
};

/**
 * Decide and issue one enrollment. Policy and registry failures return
 * `unavailable` before any unseen target authority exists. The enrollment
 * call deliberately sits outside that catch so authority errors preserve the
 * records route's existing semantics.
 */
export async function issueStorageEnrollment(
	{
		listObservations,
		readWorkspaceBytes,
		upsertObservation,
		resolveIncludedBytes,
		reportError = console.error,
	}: StorageIssuanceDependencies,
	partition: RecordsPartition,
	enroll: () => Promise<EnrollmentResponse>,
): Promise<EnrollmentResponse | 'unavailable'> {
	try {
		const observations = await listObservations(partition.principalId);
		const registeredWorkspaceIds = new Set(
			observations
				.filter((observation) => observation.sourceKind === 'workspace')
				.map((observation) => observation.sourceId),
		);
		let total = observations
			.filter((observation) => observation.sourceKind === 'blobs')
			.reduce((sum, observation) => sum + observation.observedBytes, 0);

		for (const workspaceId of registeredWorkspaceIds) {
			const observedBytes = await readWorkspaceBytes({
				principalId: partition.principalId,
				workspaceId,
			});
			await upsertObservation({
				principalId: partition.principalId,
				sourceKind: 'workspace',
				sourceId: workspaceId,
				observedBytes,
			});
			total += observedBytes;
		}

		const includedBytes = await resolveIncludedBytes();
		if (total >= includedBytes) {
			return { result: 'enrollment-refused' };
		}

		if (!registeredWorkspaceIds.has(partition.workspaceId)) {
			await upsertObservation({
				principalId: partition.principalId,
				sourceKind: 'workspace',
				sourceId: partition.workspaceId,
				observedBytes: 0,
			});
		}
	} catch (cause) {
		reportError(
			`[storage] enrollment issuance for ${partition.principalId}/${partition.workspaceId} failed: ${extractErrorMessage(cause)}`,
		);
		return 'unavailable';
	}

	return enroll();
}
