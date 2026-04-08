import { nanoid } from 'nanoid/non-secure';
import { Ok, tryAsync } from 'wellcrafted/result';
import { workspace } from '$lib/client';
import { DbServiceLive } from '$lib/services/db';
import { ToastServiceLive } from '$lib/services/toast';
import {
	type DbMigrationState,
	getDatabaseMigrationState,
	type MigrationResult,
	migrateDatabaseToWorkspace,
	probeForOldData,
	setDatabaseMigrationState,
} from './migrate-database';

function createMigrationDialog() {
	let isOpen = $state(false);
	let phase = $state<'idle' | 'running' | 'completed' | 'failed'>('idle');
	let persistedState = $state(getDatabaseMigrationState());
	let logs = $state<string[]>([]);
	let migrationResult = $state<MigrationResult | null>(null);
	let hasFailedAttempt = $state(false);
	let migrationToastId: string | undefined;

	function addLog(message: string) {
		logs.push(message);
	}

	function setPersistedState(state: DbMigrationState) {
		setDatabaseMigrationState(state);
		persistedState = state;
	}

	function showPendingToast() {
		const toastId = nanoid();
		ToastServiceLive.show({
			variant: 'info',
			id: toastId,
			title: 'Data Migration Available',
			description:
				'Your recordings and transformations can be migrated to the new workspace storage.',
			action: {
				type: 'button',
				label: 'Migrate Now',
				onClick: () => {
					isOpen = true;
				},
			},
			persist: true,
		});
		migrationToastId = toastId;
	}

	// ── Dev tools (import.meta.env.DEV only) ──
	let isSeeding = $state(false);
	let isClearing = $state(false);
	let isResetting = $state(false);

	return {
		get isOpen() {
			return isOpen;
		},
		set isOpen(value: boolean) {
			isOpen = value;
		},
		openDialog() {
			if (typeof window !== 'undefined') {
				persistedState = getDatabaseMigrationState();
			}
			isOpen = true;
		},
		get phase() {
			return phase;
		},
		get logs() {
			return logs;
		},
		get migrationResult() {
			return migrationResult;
		},
		async startWorkspaceMigration() {
			if (phase === 'running') return;

			phase = 'running';
			logs = [];
			migrationResult = null;
			hasFailedAttempt = false;
			addLog('Starting workspace migration...');

			const { data: migrationOutcome } = await tryAsync({
				try: () =>
					migrateDatabaseToWorkspace({
						dbService: DbServiceLive,
						workspace,
						onProgress: addLog,
					}),
				catch: (error) => {
					addLog(
						`❌ Migration failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					hasFailedAttempt = true;
					phase = 'failed';
					addLog('Migration state remains pending — you can retry.');
					return Ok(null);
				},
			});

			if (migrationOutcome?.error) {
				addLog(`❌ Migration failed: ${migrationOutcome.error.message}`);
				hasFailedAttempt = true;
				phase = 'failed';
				addLog('Migration state remains pending — you can retry.');
			}

			const result = migrationOutcome?.data ?? null;

			if (result) {
				migrationResult = result;
				setPersistedState('done');
				addLog('✅ Migration complete');
				if (migrationToastId) {
					ToastServiceLive.dismiss(migrationToastId);
					migrationToastId = undefined;
				}
				addLog(
					`Recordings: ${result.recordings.migrated} migrated, ${result.recordings.skipped} skipped, ${result.recordings.failed} failed`,
				);
				addLog(
					`Transformations: ${result.transformations.migrated} migrated, ${result.transformations.skipped} skipped, ${result.transformations.failed} failed`,
				);
				addLog(
					`Steps: ${result.steps.migrated} migrated, ${result.steps.skipped} skipped, ${result.steps.failed} failed`,
				);
				phase = 'completed';
			}

			if (phase === 'running') {
				phase = 'failed';
			}
		},
		get isPending() {
			return persistedState === 'pending';
		},
		get hasFailedAttempt() {
			return hasFailedAttempt;
		},
		async check() {
			const state = getDatabaseMigrationState();

			// Already done — nothing to do
			if (state === 'done') return;

			if (state === null) {
				// First check: probe for old data
				const hasData = await probeForOldData(DbServiceLive);
				if (!hasData) {
					setPersistedState('done');
					return;
				}
				setPersistedState('pending');
			}

			// State is 'pending' — show toast
			showPendingToast();
		},
		// ── Dev tools (import.meta.env.DEV only) ──
		get isSeeding() {
			return isSeeding;
		},
		get isClearing() {
			return isClearing;
		},
		get isResetting() {
			return isResetting;
		},
		/** True when any dev tool operation is in progress. */
		get isDevBusy() {
			return isSeeding || isClearing || isResetting;
		},
		async seedIndexedDB() {
			if (isSeeding) return;

			isSeeding = true;
			logs = [];

			const {
				createMigrationTestData,
				MOCK_RECORDING_COUNT,
				MOCK_TRANSFORMATION_COUNT,
			} = await import('./migration-test-data');
			const testData = createMigrationTestData();

			await tryAsync({
				try: async () => {
					await testData.seedIndexedDB({
						recordingCount: MOCK_RECORDING_COUNT,
						transformationCount: MOCK_TRANSFORMATION_COUNT,
						onProgress: addLog,
					});
				},
				catch: (error) => {
					addLog(
						`❌ Seeding failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return Ok(undefined);
				},
			});

			isSeeding = false;
		},
		async clearIndexedDB() {
			if (isClearing) return;

			isClearing = true;
			logs = [];

			const { createMigrationTestData } = await import('./migration-test-data');
			const testData = createMigrationTestData();

			await tryAsync({
				try: () => testData.clearIndexedDB({ onProgress: addLog }),
				catch: (error) => {
					addLog(
						`❌ Clear failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return Ok(undefined);
				},
			});

			isClearing = false;
		},
		async resetMigration() {
			if (isResetting) return;

			isResetting = true;
			logs = [];
			migrationResult = null;

			addLog('Clearing workspace tables...');
			workspace.tables.recordings.clear();
			workspace.tables.transformations.clear();
			workspace.tables.transformationSteps.clear();
			addLog('✅ Workspace tables cleared');

			addLog('Resetting migration state...');
			setPersistedState('pending');
			addLog('✅ Migration state reset to pending');

			isResetting = false;
		},
	};
}

export const migrationDialog = createMigrationDialog();
