import { type } from 'arktype';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import type { Transformation as TransformationType } from '$lib/services/isomorphic/db';
import { Transformation } from '$lib/services/isomorphic/db/models/transformations';
import type { DbService } from '$lib/services/isomorphic/db/types';
import type { Settings } from '$lib/settings/settings';
import { Settings as SettingsSchema } from '$lib/settings/settings';
import {
	type ConfigExport,
	ConfigExportErr,
	type ConfigExportError,
	ConfigImportErr,
	type ConfigImportError,
	ConfigValidationErr,
	type ConfigValidationError,
	type ExportConfigOptions,
	type ImportConfigOptions,
	type ImportSummary,
} from './types';

export type {
	ConfigExport,
	ConfigExportError,
	ConfigImportError,
	ConfigValidationError,
	ExportConfigOptions,
	ImportConfigOptions,
	ImportSummary,
} from './types';

/**
 * Dependencies for ConfigExportService.
 */
type ConfigExportServiceDependencies = {
	db: DbService;
};

/**
 * Service for exporting and importing application configuration.
 *
 * Handles serialization and deserialization of settings and transformations,
 * with options for security (excluding API keys) and merge strategies.
 */
export function createConfigExportService(
	deps: ConfigExportServiceDependencies,
) {
	const { db } = deps;

	/**
	 * Export current configuration to a JSON-serializable object.
	 *
	 * @param settings - Current application settings
	 * @param options - Export options (API key exclusion, etc.)
	 * @returns Serializable configuration object
	 *
	 * @example
	 * const { data: config, error } = await exportConfig(settings.value, {
	 *   includeApiKeys: false
	 * });
	 * if (error) return Err(error);
	 * const json = JSON.stringify(config, null, 2);
	 */
	async function exportConfig(
		settings: Settings,
		options: ExportConfigOptions = {},
	): Promise<Result<ConfigExport, ConfigExportError>> {
		const { includeApiKeys = false } = options;

		// Fetch all transformations
		const transformationsResult = await db.transformations.getAll();

		if (transformationsResult.error) {
			return ConfigExportErr({
				message: `Failed to fetch transformations for export: ${transformationsResult.error.message}`,
			});
		}

		// Create a copy of settings
		let exportSettings = { ...settings };

		// Remove API keys if requested
		if (!includeApiKeys) {
			const apiKeyFields: (keyof Settings)[] = [
				'apiKeys.openai',
				'apiKeys.anthropic',
				'apiKeys.groq',
				'apiKeys.google',
				'apiKeys.deepgram',
				'apiKeys.elevenlabs',
				'apiKeys.mistral',
				'apiKeys.openrouter',
				'apiKeys.custom',
			];

			for (const key of apiKeyFields) {
				(exportSettings as any)[key] = '';
			}
		}

		const config: ConfigExport = {
			version: '1.0',
			exportedAt: new Date().toISOString(),
			settings: exportSettings,
			transformations: transformationsResult.data,
		};

		return Ok(config);
	}

	/**
	 * Validate a configuration object against expected schema.
	 *
	 * @param data - Raw data to validate
	 * @returns Validated ConfigExport object
	 *
	 * @example
	 * const { data: config, error } = validateConfig(jsonData);
	 * if (error) {
	 *   console.error('Invalid config file:', error.message);
	 *   return;
	 * }
	 */
	function validateConfig(
		data: unknown,
	): Result<ConfigExport, ConfigValidationError> {
		// Check if data is an object
		if (typeof data !== 'object' || data === null) {
			return ConfigValidationErr({
				message: 'Config must be an object',
			});
		}

		const config = data as Record<string, unknown>;

		// Validate version
		if (config.version !== '1.0') {
			return ConfigValidationErr({
				message: `Unsupported config version: ${config.version}`,
			});
		}

		// Validate exportedAt
		if (typeof config.exportedAt !== 'string') {
			return ConfigValidationErr({
				message: 'Config must have exportedAt timestamp',
			});
		}

		// Validate settings
		const settingsResult = trySync({
			try: () => {
				const result = SettingsSchema(config.settings);
				if (result instanceof type.errors) {
					throw new Error(result.summary);
				}
				return result;
			},
			catch: (e) =>
				ConfigValidationErr({
					message: `Invalid settings schema: ${e instanceof Error ? e.message : String(e)}`,
				}),
		});

		if (settingsResult.error) {
			return Err(settingsResult.error);
		}

		// Validate transformations array
		if (!Array.isArray(config.transformations)) {
			return ConfigValidationErr({
				message: 'Config must have transformations array',
			});
		}

		// Validate each transformation
		const validatedTransformations: TransformationType[] = [];
		for (const [index, transformation] of config.transformations.entries()) {
			const transformationResult = trySync({
				try: () => {
					const result = Transformation(transformation);
					if (result instanceof type.errors) {
						throw new Error(result.summary);
					}
					return result as TransformationType;
				},
				catch: (e) =>
					ConfigValidationErr({
						message: `Invalid transformation at index ${index}: ${e instanceof Error ? e.message : String(e)}`,
					}),
			});

			if (transformationResult.error) {
				return Err(transformationResult.error);
			}

			validatedTransformations.push(transformationResult.data);
		}

		return Ok({
			version: '1.0',
			exportedAt: config.exportedAt as string,
			settings: settingsResult.data,
			transformations: validatedTransformations,
		});
	}

	/**
	 * Import configuration from a validated ConfigExport object.
	 *
	 * @param config - Validated configuration to import
	 * @param options - Import options (merge strategy, etc.)
	 * @returns Summary of what was imported
	 *
	 * @example
	 * // Replace mode - overwrites everything
	 * const { data: summary, error } = await importConfig(config, {
	 *   mergeStrategy: 'replace'
	 * });
	 *
	 * @example
	 * // Merge mode - keeps existing, adds new
	 * const { data: summary, error } = await importConfig(config, {
	 *   mergeStrategy: 'merge'
	 * });
	 */
	async function importConfig(
		config: ConfigExport,
		options: ImportConfigOptions = {},
	): Promise<Result<ImportSummary, ConfigImportError>> {
		const { mergeStrategy = 'replace' } = options;

		const summary: ImportSummary = {
			settingsUpdated: 0,
			transformationsCreated: 0,
			transformationsUpdated: 0,
			transformationsSkipped: 0,
		};

		// Settings are always imported (there's only one settings object)
		// The settings will be applied by the caller using settings.update()
		summary.settingsUpdated = Object.keys(config.settings).length;

		// Handle transformations based on merge strategy
		if (mergeStrategy === 'replace') {
			// Clear existing transformations first
			const clearResult = await db.transformations.clear();
			if (clearResult.error) {
				return ConfigImportErr({
					message: `Failed to clear existing transformations: ${clearResult.error.message}`,
				});
			}

			// Create all imported transformations
			for (const transformation of config.transformations) {
				const createResult = await db.transformations.create(transformation);
				if (createResult.error) {
					// Log error but continue with other transformations
					console.error(
						'Failed to import transformation:',
						transformation.id,
						createResult.error,
					);
					summary.transformationsSkipped++;
				} else {
					summary.transformationsCreated++;
				}
			}
		} else {
			// Merge mode: keep existing, add new, update if IDs match
			const existingResult = await db.transformations.getAll();
			if (existingResult.error) {
				return ConfigImportErr({
					message: `Failed to fetch existing transformations: ${existingResult.error.message}`,
				});
			}

			const existingIds = new Set(existingResult.data.map((t) => t.id));

			for (const transformation of config.transformations) {
				if (existingIds.has(transformation.id)) {
					// Update existing transformation
					const updateResult = await db.transformations.update(transformation);
					if (updateResult.error) {
						console.error(
							'Failed to update transformation:',
							transformation.id,
							updateResult.error,
						);
						summary.transformationsSkipped++;
					} else {
						summary.transformationsUpdated++;
					}
				} else {
					// Create new transformation
					const createResult = await db.transformations.create(transformation);
					if (createResult.error) {
						console.error(
							'Failed to create transformation:',
							transformation.id,
							createResult.error,
						);
						summary.transformationsSkipped++;
					} else {
						summary.transformationsCreated++;
					}
				}
			}
		}

		return Ok(summary);
	}

	return {
		exportConfig,
		validateConfig,
		importConfig,
	};
}

export const ConfigExportService = {
	create: createConfigExportService,
};
