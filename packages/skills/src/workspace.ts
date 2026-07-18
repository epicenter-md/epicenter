import {
	defineWorkspace,
	type WorkspaceHandle,
} from '@epicenter/workspace/sqlite';
import { SKILLS_WORKSPACE_ID } from './constants.js';
import { referencesTable, skillsTable } from './tables.js';

/**
 * The inert Skills contract. A caller binds it through its environment-owned
 * runtime and passes the resulting handle to ordinary application services.
 */
export const skillsWorkspace = defineWorkspace({
	id: SKILLS_WORKSPACE_ID,
	tables: {
		skills: skillsTable,
		references: referencesTable,
	},
});

export type SkillsWorkspace = WorkspaceHandle<typeof skillsWorkspace>;
