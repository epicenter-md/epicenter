import { createDesktopWorkspaceOwner } from '@epicenter/workspace/sqlite/desktop-owner';

export const BUILT_IN_WORKSPACE_IDS = Object.freeze([
	'epicenter-conversations',
	'epicenter-honeycrisp',
	'epicenter-skills',
	'epicenter-whispering',
]);

/** The Bun-side schema-opaque owner over the startup-derived workspace inventory. */
export function createEpicenterWorkspaceOwner(
	workspacesRoot: string,
	workspaceIds: readonly string[],
) {
	return createDesktopWorkspaceOwner({
		workspacesRoot,
		workspaceIds,
	});
}
