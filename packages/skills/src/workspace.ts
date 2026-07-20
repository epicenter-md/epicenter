import type { BoundData } from '@epicenter/data';
import { referencesTable, skillsTable } from './tables.js';

/**
 * The inert Skills contract. A caller binds it through its environment-owned
 * runtime and passes the resulting handle to ordinary application services.
 */
export const skillsDefinitions = {
	tables: {
		skills: skillsTable,
		references: referencesTable,
	},
	values: {},
} as const;

export type SkillsData = BoundData<
	typeof skillsDefinitions.tables,
	typeof skillsDefinitions.values
>;
