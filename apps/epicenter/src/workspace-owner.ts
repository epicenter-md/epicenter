import { join } from 'node:path';
import { skillsWorkspace } from '@epicenter/skills';
import { whisperingWorkspace } from '@epicenter/whispering/workspace-contract';
import { createDesktopWorkspaceOwner } from '@epicenter/workspace/sqlite/desktop-owner';

/** The executable workspace lineage statically linked into the Bun sidecar. */
export function createEpicenterWorkspaceOwner(dataDir: string) {
	return createDesktopWorkspaceOwner({
		authorityKey: 'epicenter-desktop-local',
		storageRoot: join(dataDir, 'workspace-runtime'),
		definitions: [skillsWorkspace, whisperingWorkspace],
	});
}
