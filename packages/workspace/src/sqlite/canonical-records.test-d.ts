/**
 * Schema-Opaque Canonical Records Type Tests
 *
 * Locks structural runtime-owned identity, required and optional row inference,
 * and the exact typed patch boundary. Runtime behavior is covered separately
 * in `canonical-records.test.ts`.
 */

import { field } from '@epicenter/field';
import type { CanonicalTable } from './canonical-records.js';
import { defineTable, type RowFor } from './lens-definition.js';

const skillsDefinition = defineTable({
	fields: {
		title: field.string(),
		archived: field.boolean(),
		rating: field.number(),
	},
	optional: ['archived', 'rating'],
});

type Skill = RowFor<typeof skillsDefinition>;

const validSkill: Skill = { id: 'skill-1', title: 'Concise' };
const validCompleteSkill: Skill = {
	id: 'skill-2',
	title: 'Complete',
	archived: false,
	rating: 4,
};

// @ts-expect-error: current-lens rows require the title field
const missingRequired: Skill = { id: 'skill-3' };
const invalidOptional: Skill = {
	id: 'skill-4',
	title: 'Wrong',
	// @ts-expect-error: present optional values retain their field schema
	rating: 'high',
};

declare const skills: CanonicalTable<typeof skillsDefinition>;

const getResult = skills.get('skill-1');
if (getResult.error === null) {
	const found: Skill | undefined = getResult.data;
	void found;
}

skills.create({ title: 'Allocated by runtime' });
// @ts-expect-error: callers cannot choose structural row identity
skills.create({ id: 'caller-id', title: 'Forbidden' });
// @ts-expect-error: create requires every current-lens required field
skills.create({ archived: false });

const patchResult = skills.patch('skill-1', { title: 'Updated' });
if (patchResult.error === null) {
	const patched: Skill | undefined = patchResult.data;
	void patched;
}
skills.patch('skill-1', { archived: undefined });
skills.patch('skill-1', { rating: 5 });
// @ts-expect-error: required fields cannot be unset
skills.patch('skill-1', { title: undefined });
// @ts-expect-error: patches accept only fields declared by this lens
skills.patch('skill-1', { future: true });
// @ts-expect-error: patch values retain the declared field schema
skills.patch('skill-1', { rating: 'high' });

// @ts-expect-error: id is structural and never belongs in field declarations
defineTable({
	fields: {
		id: field.string(),
		title: field.string(),
	},
});

void validSkill;
void validCompleteSkill;
void missingRequired;
void invalidOptional;
