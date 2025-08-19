/**
 * Filesystem driver abstraction (host app provides). Kept tiny on purpose.
 */
export interface FileStore {
	read(path: string): Promise<string | undefined>; // undefined for missing
	write(path: string, contents: string): Promise<void>;
	remove(path: string): Promise<void>;
	list(prefix?: string): Promise<string[]>; // returns relative file paths
}

/**
 * Merge driver hook: allows custom resolution for frontmatter or structured text.
 * Implementations can be wired via .gitattributes to reduce human conflicts.
 */
export interface MergeDriver {
	/** Returns merged contents or undefined if it can’t auto-merge. */
	merge(
		base: string | undefined,
		current: string | undefined,
		incoming: string | undefined,
		path: string,
	): Promise<string | undefined>;
}

// Atomic write intent; the sync engine can batch these under a transaction/journal
export type WriteIntent = {
	/** Full relative path (POSIX style) */
	path: string;
	/** UTF-8 text content; caller performs deterministic formatting first */
	contents: string;
};

// Captures a filesystem snapshot used for 3-way merges
export type FsSnapshot = {
	/** content hash per path (e.g., sha256 of file contents) */
	files: Record<string, string>;
	/** optional marker to match schema revisions */
	schemaVersion?: number;
	/** timestamp of snapshot creation */
	createdAt: string;
};

// --- Sync planning types (DB <-> FS) ---

export type SyncIntent = {
	writes: WriteIntent[];
	deletes: string[]; // relative paths to remove
};

export type Conflict =
	| { type: 'text'; path: string }
	| { type: 'entity'; ref: EntityRef; reason: string };

export type SyncPlan = {
	intents: SyncIntent;
	conflicts: Conflict[];
	/** baseline snapshot used to compute the plan */
	base?: FsSnapshot;
};

// A single entity in the domain (table row, document, etc.)
export type EntityRef = { kind: string; id: string };

// A minimal change unit from parsing a plaintext document
export type EntityPatch<T = unknown> = {
	ref: EntityRef;
	/** Partial update to apply (already validated against Importer.validator) */
	data: T;
};
