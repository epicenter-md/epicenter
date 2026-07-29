/**
 * Ownership guard for long-running async work a component started.
 *
 * Exists because of a specific defect: the TikTok composer resumed following an
 * in-flight post with
 *
 *   refreshAttempts().then(() => { if (live) follow(live.publishId) })
 *
 * and nothing stopped that continuation from running after the component was
 * destroyed. Switching accounts or leaving the page during the `await` started a
 * ten-minute polling loop owned by a surface that no longer existed, writing
 * state nobody would ever read and calling TikTok on a schedule nobody could
 * cancel.
 *
 * A plain boolean is not enough, because there are two distinct ways a run stops
 * being the owner: a NEWER run of the same work superseded it, or the component
 * went away entirely. This tracks both, and closing is permanent so a
 * continuation that arrives late cannot open a fresh run.
 *
 * Deliberately not reactive and not Svelte-aware, so the rule is unit-testable
 * without a DOM.
 */
export function createFollowGate() {
	let generation = 0;
	let closed = false;

	return {
		/**
		 * Claim the gate for a new run, superseding any run already in flight.
		 *
		 * Returns the predicate that run must consult after every `await`: it is
		 * true only while this exact run is still the owner. Call it BEFORE doing any
		 * work too, because a run begun after `close()` never owns the gate.
		 */
		begin(): () => boolean {
			const mine = ++generation;
			return () => !closed && generation === mine;
		},

		/**
		 * The component is gone. Permanent: every in-flight run stops owning the
		 * gate, and every future `begin()` is dead on arrival.
		 */
		close(): void {
			closed = true;
			generation += 1;
		},

		/** Whether the gate has been closed for good. */
		get isClosed(): boolean {
			return closed;
		},
	};
}

export type FollowGate = ReturnType<typeof createFollowGate>;
