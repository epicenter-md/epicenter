export {
	type Address,
	type AddressByteCeilings,
	AddressSchema,
	addressesEqual,
	addressKey,
	canonicalJson,
	DATA_ADDRESS_CEILINGS,
	isAddress,
	isAdmissibleAddress,
	isJsonObject,
	isJsonValue,
	isNamespace,
	isRowAddress,
	isRuntimeId,
	isTableName,
	isValueAddress,
	isValueName,
	type RowAddress,
	RowAddressSchema,
	SQLITE_UNUSABLE_AS_RELATION_NAME,
	sha256Hex,
	type ValueAddress,
	ValueAddressSchema,
} from '@epicenter/lens';
export {
	DATA_ADMISSION_LIMITS,
	encodedBytes,
	encodedJsonBytes,
	isAdmissibleFact,
	isAdmissibleIntent,
} from './admission.js';
export { type FoldResult, foldIntent } from './fold.js';
export {
	type Batch,
	BatchSchema,
	type Cursor,
	CursorSchema,
	type ExchangeRequest,
	ExchangeRequestSchema,
	type ExchangeResponse,
	ExchangeResponseSchema,
	type ExchangeSuccess,
	type Fact,
	FactSchema,
	type Intent,
	IntentSchema,
	type JsonObject,
	type JsonValue,
	type LocalFact,
	ProtocolValidationError,
	parseExchangeRequest,
	parseExchangeResponse,
	parseFact,
	parseIntent,
	parseJsonValue,
	parseReplicaId,
	parseRowId,
	type Receipt,
	ReceiptSchema,
	type ReplicaId,
	ReplicaIdSchema,
	type RowId,
	RowIdSchema,
} from './schemas.js';

import { canonicalJson, sha256Hex } from '@epicenter/lens';
import type { Intent } from './schemas.js';

export function batchDigest(intents: readonly Intent[]): string {
	return sha256Hex(canonicalJson(intents));
}
