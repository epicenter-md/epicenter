import { canonicalJson } from './canonical-json.js';
import type { RecordCommand } from './protocol.js';

/**
 * Deterministic digest binding a sealed round to its exact ordered commands
 * (ADR-0131). A retry whose digest matches the accepted round refolds
 * nothing; a mismatch on the accepted round is the terminal fork verdict.
 */
export function recordRoundDigest(commands: readonly RecordCommand[]): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(canonicalJson(commands))) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, '0');
}
