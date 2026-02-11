/**
 * A registered static workspace for viewing
 */
export type StaticWorkspaceEntry = {
	/** Unique workspace identifier (used as Y.Doc guid) */
	id: string;
	/** Display name (defaults to id if not provided) */
	name?: string;
	/** Icon in tagged format: 'emoji:📊' or 'lucide:layout-grid' */
	icon?: string;
	/** Override sync server URL (uses app default if not set) */
	syncUrl?: string;
	/** When this entry was added */
	addedAt: string; // ISO 8601
};

/**
 * The static workspaces registry file format
 */
export type StaticWorkspacesRegistry = {
	/** Schema version for future migrations */
	version: 1;
	/** List of registered static workspaces */
	workspaces: StaticWorkspaceEntry[];
};
