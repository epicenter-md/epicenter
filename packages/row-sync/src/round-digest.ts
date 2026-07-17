import { canonicalJson } from './canonical-json.js';
import type { RecordCommand } from './protocol.js';
import { sha256Hex } from './sha256.js';

/**
 * Deterministic digest binding a sealed round to its exact ordered commands
 * (ADR-0131). A retry whose digest matches the accepted round refolds
 * nothing; a mismatch on the accepted round is the terminal fork verdict.
 * SHA-256 keeps a forked replica from constructing a divergent command array
 * that impersonates its accepted round.
 */
export function recordRoundDigest(commands: readonly RecordCommand[]): string {
	return sha256Hex(canonicalJson(commands));
}
