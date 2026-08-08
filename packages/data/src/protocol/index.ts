/**
 * The data protocol boundary.
 *
 * What crosses it: the address vocabulary, the wire types, the admission
 * limits, the parsers that admit untrusted input, the authority fold, and the
 * batch digest. That is the whole contract a replica or an authority needs.
 *
 * What deliberately does not cross it. The typebox schema objects behind the
 * parsers stay private, because validating means calling `parseFact` rather
 * than hand-driving `Value.Check(FactSchema, ...)`, and publishing both invites
 * a second admission path that skips the extra checks the parsers apply. The
 * admission predicates stay private for the same reason: the parsers already
 * run them. And `@epicenter/lens` owns the inert Lens vocabulary, so only the
 * lens symbols this protocol's own signatures name are re-exported here; the
 * rest are imported from lens directly rather than through a second door.
 */
export { addressesEqual, addressKey, DATA_ADDRESS_CEILINGS, isRowAddress, type RowAddress } from '@epicenter/lens';
export { DATA_ADMISSION_LIMITS, encodedJsonBytes } from './admission.js';
export { type FoldResult, foldIntent } from './fold.js';
export {
	type Batch,
	type Cursor,
	type ExchangeRequest,
	type ExchangeResponse,
	type Fact,
	type Intent,
	type JsonObject,
	type JsonValue,
	type LocalFact,
	ProtocolValidationError,
	parseExchangeRequest,
	parseExchangeResponse,
	parseFact,
	parseIntent,
	parseReplicaId,
	type Receipt,
	type ReplicaId,
} from './schemas.js';

import { canonicalJson, sha256Hex } from '@epicenter/lens';
import type { Intent } from './schemas.js';

export function batchDigest(intents: readonly Intent[]): string {
	return sha256Hex(canonicalJson(intents));
}
