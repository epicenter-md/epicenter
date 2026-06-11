/**
 * Name validation regex from Agent Skills spec.
 *
 * Rules:
 * - Lowercase alphanumeric + hyphens only
 * - Must start and end with alphanumeric
 * - No consecutive hyphens
 * - 1-64 characters
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate skill fields against the Agent Skills spec.
 *
 * Returns an array of human-readable error strings. Empty array = valid.
 * Runs on save and before export, never blocks editing.
 *
 * @example
 * ```typescript
 * const errors = validateSkill({ name: 'My Skill', description: '' });
 * // ['name must be lowercase alphanumeric...', 'description is required']
 * ```
 */
export function validateSkill(fields: {
	name: string;
	description: string;
	license?: string | null;
	compatibility?: string | null;
}): string[] {
	const errors: string[] = [];

	// name: required, 1-64 chars, lowercase + hyphens, no leading/trailing/consecutive hyphens
	if (!fields.name) {
		errors.push('name is required');
	} else if (fields.name.length > 64) {
		errors.push('name must be ≤64 characters');
	} else if (!SKILL_NAME_PATTERN.test(fields.name)) {
		errors.push(
			'name must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens',
		);
	}
	if (fields.name?.includes('--')) {
		errors.push('name must not contain consecutive hyphens');
	}

	// description: required, 1-1024 chars
	if (!fields.description) {
		errors.push('description is required');
	} else if (fields.description.length > 1024) {
		errors.push('description must be ≤1024 characters');
	}

	// compatibility: optional, ≤500 chars
	if (fields.compatibility && fields.compatibility.length > 500) {
		errors.push('compatibility must be ≤500 characters');
	}

	return errors;
}
