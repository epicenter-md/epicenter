import {
	assertCanonicalRecordsDescriptor,
	type RecordsSchemaCells,
	type RecordsSchemaRef,
	recordsSchemaHashOf,
	recordsSchemaRef,
	sealRecordsSchemaIdentity,
} from './schema-descriptor.js';

/**
 * One inert historical records schema. The descriptor is the sole stored
 * truth; its hash is always derived, so generated modules cannot drift into a
 * descriptor/hash mismatch state.
 */
export type HistoricalSchema<
	TCells extends RecordsSchemaCells = RecordsSchemaCells,
> = RecordsSchemaRef<TCells, 'historical'>;

/** Bind generated migration cell types to one validated canonical descriptor. */
export function historicalSchema<TCells extends RecordsSchemaCells>(
	recordsDescriptor: string,
): HistoricalSchema<TCells> {
	assertCanonicalRecordsDescriptor(recordsDescriptor);
	return Object.freeze(
		sealRecordsSchemaIdentity({
			recordsDescriptor,
			recordsSchemaHash: recordsSchemaHashOf(recordsDescriptor),
			[recordsSchemaRef]: { kind: 'historical' },
		}),
	);
}
