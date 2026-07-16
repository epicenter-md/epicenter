import { canonicalJson } from './canonical-json.js';
import type { PushRequest } from './protocol.js';

/** Deterministic checksum binding a push receipt to one exact request. */
export function recordBatchChecksum(request: PushRequest): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(canonicalJson(request))) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, '0');
}
