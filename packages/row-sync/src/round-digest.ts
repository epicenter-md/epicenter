import { canonicalJson } from './canonical-json.js';
import type { WireRowIntent } from './protocol.js';
import { sha256Hex } from './sha256.js';

/**
 * Deterministic digest binding a sealed round to its exact ordered intents
 * (ADR-0131). A retry whose digest matches the accepted round refolds
 * nothing; a mismatch on the accepted round is the terminal fork verdict.
 * The digest is computed over the canonical wire encoding, so the base64
 * document form is the content-addressed form. SHA-256 keeps a forked
 * replica from constructing a divergent intent array that impersonates its
 * accepted round.
 */
export function rowRoundDigest(intents: readonly WireRowIntent[]): string {
	return sha256Hex(canonicalJson(intents));
}
