/**
 * How a Query client reads a host's directory liveness (ADR-0115).
 * The directory carries only `hostId`, `label`, and a three-valued `status`
 * (`@epicenter/server`); it names what to dial, never what the host can do. This
 * is the client's interpretation of that status: whether a new local-source
 * question may start right now.
 *
 * The two planes answer differently (ADR-0079, ADR-0080):
 * - Reading synced history is a durable-replica read (the transcript, ADR-0055).
 *   It needs no live host, so it is never gated on status: an `offline` or
 *   `unreachable` desktop still lets the phone read the finished transcript.
 * - Asking a new local-source question needs the live host session over the
 *   relay. It is gated: only an `online` host can run a fresh turn.
 *
 * `offline` and `unreachable` both deny a new question, but they are distinct so
 * a client renders the right recovery ("wake your desktop" versus
 * "reconnecting"). Neither is inferable from the client's own relay socket: the
 * phone can be connected to the relay while the host is not, which is exactly the
 * `unreachable` state, so this reads the host's directory status, not the socket.
 */

import type { AttachHostStatus } from '@epicenter/server/bun';

/**
 * May the client start a new local-source question against a host in this state?
 * Only when the host is `online`: a fresh turn needs the live session. History
 * reading is a separate, never-gated durable-replica read.
 */
export function canAskLocalSource(status: AttachHostStatus): boolean {
	return status === 'online';
}
