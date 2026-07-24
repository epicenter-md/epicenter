export {
	DATA_ADMISSION_LIMITS,
	encodedBytes,
	encodedJsonBytes,
	isAdmissibleChange,
	isAdmissibleRecord,
	isJsonObject,
	isJsonValue,
	isQualifiedKey,
	isRuntimeId,
} from './admission.js';
export { canonicalJson, sha256Hex, sha256HexBytes } from './canonical.js';
export { type FoldResult, foldChange } from './fold.js';
export {
	type Batch,
	BatchSchema,
	type Change,
	ChangeSchema,
	type Cursor,
	CursorSchema,
	type ExchangeRequest,
	ExchangeRequestSchema,
	type ExchangeResponse,
	ExchangeResponseSchema,
	type ExchangeSuccess,
	type JsonObject,
	type JsonValue,
	ProtocolValidationError,
	parseChange,
	parseExchangeRequest,
	parseExchangeResponse,
	parseJsonValue,
	parseQualifiedKey,
	parseRecord,
	parseReplicaId,
	parseRowId,
	type QualifiedKey,
	QualifiedKeySchema,
	type Receipt,
	ReceiptSchema,
	type Record,
	RecordSchema,
	type ReplicaId,
	ReplicaIdSchema,
	type RowId,
	RowIdSchema,
} from './schemas.js';

import { canonicalJson, sha256Hex } from './canonical.js';
import type { Change } from './schemas.js';

export function batchDigest(changes: readonly Change[]): string {
	return sha256Hex(canonicalJson(changes));
}
