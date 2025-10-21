import { type } from 'arktype';

export const InsertEntitiesInputSchema = type({
	entities: type({
		id: 'string',
		name: 'string | null | undefined',
		type: 'string | null | undefined',
		description: 'string | null | undefined',
		public_id: 'string | null | undefined',
		created_at: 'string | number | Date | null | undefined',
	}).array(),
	occurrences: type({
		id: 'string',
		entity_id: 'string',
		source_adapter_id: 'string',
		source_table_name: 'string',
		source_pk_json: 'string',
		discovered_at: 'string | number | Date | null | undefined',
	}).array(),
});

export type InsertEntitiesInput = typeof InsertEntitiesInputSchema.infer;
