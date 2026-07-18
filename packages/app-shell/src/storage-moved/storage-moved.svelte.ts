import { isWorkspaceStorageMovedError } from '@epicenter/workspace/sqlite';

let moved = $state(false);

/**
 * One app-wide "this tab's workspace storage moved to a newer tab" state.
 *
 * The browser runtime steals storage newest-tab-wins; the stolen tab's
 * Worker reports the steal once through `onBackgroundError` and then fails
 * every operation. Wire `observe` into that callback and render
 * `<StorageMovedScreen />` while `current` is true so the stolen tab shows
 * one blocking state instead of a stale-live UI with scattered failures.
 */
export const storageMoved = {
	get current(): boolean {
		return moved;
	},
	/** Flips the moved state when the cause is the storage-moved error. */
	observe(cause: unknown): void {
		if (isWorkspaceStorageMovedError(cause)) moved = true;
	},
};
