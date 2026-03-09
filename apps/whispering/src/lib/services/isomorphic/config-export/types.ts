import { createTaggedError } from 'wellcrafted/error';
import type { Transformation } from '$lib/services/isomorphic/db';
import type { Settings } from '$lib/settings/settings';

/**
 * Configuration export format.
 * Contains all user settings and transformations in a portable JSON format.
 */
export type ConfigExport = {
	/** Schema version for future migration compatibility */
	version: '1.0';
	/** ISO timestamp of when the config was exported */
	exportedAt: string;
	/** All application settings */
	settings: Settings;
	/** User-created transformation pipelines */
	transformations: Transformation[];
};

/**
 * Options for exporting configuration.
 */
export type ExportConfigOptions = {
	/**
	 * Whether to include API keys in the export.
	 * @default false - API keys are excluded for security
	 */
	includeApiKeys?: boolean;
};

/**
 * Strategy for handling conflicts during import.
 */
export type ImportMergeStrategy =
	/** Replace all existing config with imported data */
	| 'replace'
	/** Merge imported data with existing, keeping newer items */
	| 'merge';

/**
 * Options for importing configuration.
 */
export type ImportConfigOptions = {
	/**
	 * How to handle conflicts between existing and imported data.
	 * @default 'replace'
	 */
	mergeStrategy?: ImportMergeStrategy;
};

/**
 * Summary of what was imported.
 */
export type ImportSummary = {
	/** Number of settings updated */
	settingsUpdated: number;
	/** Number of transformations created */
	transformationsCreated: number;
	/** Number of transformations updated (merge mode only) */
	transformationsUpdated: number;
	/** Number of transformations skipped */
	transformationsSkipped: number;
};

// ============================================================================
// Errors
// ============================================================================

export const { ConfigExportError, ConfigExportErr } =
	createTaggedError('ConfigExportError');
export type ConfigExportError = ReturnType<typeof ConfigExportError>;

export const { ConfigImportError, ConfigImportErr } =
	createTaggedError('ConfigImportError');
export type ConfigImportError = ReturnType<typeof ConfigImportError>;

export const { ConfigValidationError, ConfigValidationErr } = createTaggedError(
	'ConfigValidationError',
);
export type ConfigValidationError = ReturnType<typeof ConfigValidationError>;
