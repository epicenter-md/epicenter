import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { skillsWorkspace } from '@epicenter/skills';
import { whisperingWorkspace } from '@epicenter/whispering/workspace-contract';
import { createDesktopWorkspaceOwner } from '@epicenter/workspace/sqlite/desktop-owner';
import { conversationsWorkspace } from './workspace.ts';

/** The executable workspace lineage statically linked into the Bun sidecar. */
export function createEpicenterWorkspaceOwner(workspacesRoot: string) {
	return createDesktopWorkspaceOwner({
		workspacesRoot,
		definitions: [
			conversationsWorkspace,
			honeycrispWorkspace,
			skillsWorkspace,
			whisperingWorkspace,
		],
	});
}
