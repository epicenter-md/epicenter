/**
 * Shared contracts for the build-selected shortcut surface. Browser and
 * Epicenter implementations conform to these shapes even though each build
 * resolves only its selected composition root.
 */

import type { Command } from '$lib/commands';
import type { KeyBinding } from '$lib/utils/key-binding';

/**
 * Why a binding cannot be assigned, as structured data rather than prose. The
 * backends and the reach router return this; the recorder renders it to a message
 * (with the command titles it has on hand) at the one place a
 * conflict is shown, so the policy layer never owns user-facing strings.
 *
 * - `reserved`: an OS-reserved global gesture (`reason` is self-contained).
 * - `duplicate`: this backend already binds this exact gesture to `commandId`.
 * - `crossStore`: on desktop, `commandId`'s binding in the OTHER store is the same
 *   gesture, so both would fire in the focused window.
 */
export type ShortcutConflict =
	| { kind: 'reserved'; reason: string }
	| { kind: 'duplicate'; commandId: Command['id'] }
	| { kind: 'crossStore'; commandId: Command['id'] };

/**
 * Contract for a single shortcut backend. Two implement it: `focusedShortcuts`
 * (in-app keydown shortcuts in workspace KV, universal) and `systemShortcuts`
 * (system-global plugin-chord bindings in device-config, Epicenter-only). The
 * build-selected shortcut root composes the available backends and routes each write by realized reach
 * (ADR-0052), so app code talks to the router, not to a backend directly. The
 * trigger dispatch itself converges in `dispatchCommandTrigger`; this owns the
 * binding configuration around it.
 */
export type Shortcuts = {
	/** Push every command's configured binding to this platform's backend. */
	sync(): Promise<void>;
	/** Restore every shortcut to its default binding, then re-sync. */
	reset(): void;
	/**
	 * The command's current binding (`null` when unbound). What the recorder reads
	 * to show and prefill the binding, instead of reaching into platform storage
	 * and re-deriving the storage-key scheme the backend already owns. Display-only
	 * consumers format it through `keyBindingToLabel` at the call site.
	 */
	current(commandId: Command['id']): KeyBinding | null;
	/** Persist a binding for this command and push it to the platform runtime. */
	set(commandId: Command['id'], binding: KeyBinding): Promise<void>;
	/** Clear this command's binding and push the removal. */
	clear(commandId: Command['id']): Promise<void>;
	/**
	 * Why `binding` cannot be assigned to this command, or `null` when it is
	 * allowed, as structured {@link ShortcutConflict} (the recorder renders the
	 * message). The policy lives in each backend: the in-app backend
	 * refuses an exact duplicate (its matcher fires every command whose set
	 * matches); the global backend also refuses OS-reserved gestures.
	 */
	findConflict(
		commandId: Command['id'],
		binding: KeyBinding,
	): ShortcutConflict | null;
};

