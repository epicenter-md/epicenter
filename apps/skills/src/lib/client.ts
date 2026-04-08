import { createSkillsWorkspace } from '@epicenter/skills';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';

export const workspace = createSkillsWorkspace().withExtension(
	'persistence',
	indexeddbPersistence,
);
