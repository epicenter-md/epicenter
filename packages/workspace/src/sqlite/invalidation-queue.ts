import type { WorkspaceInvalidation } from './service-protocol.js';

type InvalidationRefreshQueueOptions = {
	tables: ReadonlySet<string>;
	kv: ReadonlySet<string>;
	refresh(invalidation: WorkspaceInvalidation): Promise<void>;
	onError(error: unknown): void;
	retryDelaysMs?: readonly number[];
};

/** Coalesce cross-owner invalidations and retain them until a refresh succeeds. */
export function createInvalidationRefreshQueue({
	tables,
	kv,
	refresh,
	onError,
	retryDelaysMs = [25, 50, 100, 250],
}: InvalidationRefreshQueueOptions) {
	const pendingTables = new Map<string, Set<string>>();
	const pendingKv = new Set<string>();
	let version = 0;
	let drainPromise: Promise<void> | undefined;
	let isDisposed = false;
	let cancelDelay: (() => void) | undefined;

	function report(error: unknown): void {
		try {
			onError(error);
		} catch {
			// A broken error sink must not stop invalidation recovery.
		}
	}

	function hasPending(): boolean {
		return pendingTables.size > 0 || pendingKv.size > 0;
	}

	function snapshot(): WorkspaceInvalidation {
		return {
			tables: Object.fromEntries(
				[...pendingTables].map(([table, ids]) => [table, [...ids]]),
			),
			kv: [...pendingKv],
		};
	}

	function wait(delayMs: number): Promise<void> {
		if (delayMs <= 0) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				cancelDelay = undefined;
				resolve();
			}, delayMs);
			cancelDelay = () => {
				clearTimeout(timer);
				cancelDelay = undefined;
				resolve();
			};
		});
	}

	async function drain(): Promise<void> {
		let failureCount = 0;
		while (!isDisposed && hasPending()) {
			const targetVersion = version;
			try {
				await refresh(snapshot());
				failureCount = 0;
				if (version === targetVersion) {
					pendingTables.clear();
					pendingKv.clear();
				}
			} catch (error) {
				report(error);
				if (isDisposed) break;
				const delay =
					retryDelaysMs[
						Math.min(failureCount, Math.max(0, retryDelaysMs.length - 1))
					] ?? 0;
				failureCount++;
				await wait(delay);
			}
		}
	}

	function startDrain(): void {
		if (drainPromise || isDisposed || !hasPending()) return;
		drainPromise = drain().finally(() => {
			drainPromise = undefined;
			if (!isDisposed && hasPending()) startDrain();
		});
	}

	return {
		enqueue(invalidation: WorkspaceInvalidation): void {
			if (isDisposed) return;
			for (const [table, ids] of Object.entries(invalidation.tables)) {
				if (!tables.has(table)) {
					report(new Error(`Invalidation names unknown table '${table}'`));
					continue;
				}
				let pendingIds = pendingTables.get(table);
				if (!pendingIds) {
					pendingIds = new Set();
					pendingTables.set(table, pendingIds);
				}
				for (const id of ids) pendingIds.add(id);
			}
			for (const key of invalidation.kv) {
				if (!kv.has(key)) {
					report(new Error(`Invalidation names unknown KV key '${key}'`));
					continue;
				}
				pendingKv.add(key);
			}
			if (!hasPending()) return;
			version++;
			startDrain();
		},
		async dispose(): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			cancelDelay?.();
			await drainPromise;
			pendingTables.clear();
			pendingKv.clear();
		},
	};
}
