import { type BoundData, defineLens } from '@epicenter/data';
import { referencesTable, skillsTable } from './tables.js';

/**
 * The inert Skills contract. A caller binds it through its environment-owned
 * runtime and passes the resulting handle to ordinary application services.
 */
export const skillsLens = defineLens({
	namespace: 'so.epicenter.skills',
	tables: {
		skills: skillsTable,
		skillReferences: referencesTable,
	},
});

export type SkillsData = BoundData<typeof skillsLens.tables>;
