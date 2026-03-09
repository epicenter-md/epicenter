import { Err, Ok } from 'wellcrafted/result';
import { defineMutation, defineQuery } from '$lib/query/client';
import { services } from '$lib/services';
import type {
	ConfigExport,
	ExportConfigOptions,
	ImportConfigOptions,
} from '$lib/services/isomorphic/config-export';
import type { Settings } from '$lib/settings/settings';

/**
 * Query keys for config export/import operations
 */
export const configKeys = {
	validate: (data: unknown) => ['config', 'validate', data] as const,
};

/**
 * Config export/import query layer
 */
export const config = {
	/**
	 * Export current configuration to JSON
	 */
	export: defineMutation({
		mutationKey: ['config', 'export'] as const,
		mutationFn: async (params: {
			settings: Settings;
			options?: ExportConfigOptions;
		}) => {
			const { settings, options } = params;
			const { data, error } = await services.configExport.exportConfig(
				settings,
				options,
			);

			if (error) {
				return Err({
					title: 'Failed to export configuration',
					description: error.message,
					action: { type: 'more-details' as const, error },
				});
			}

			return Ok(data);
		},
	}),

	/**
	 * Import configuration from validated ConfigExport object
	 */
	import: defineMutation({
		mutationKey: ['config', 'import'] as const,
		mutationFn: async (params: {
			config: ConfigExport;
			options?: ImportConfigOptions;
		}) => {
			const { config: configData, options } = params;
			const { data, error } = await services.configExport.importConfig(
				configData,
				options,
			);

			if (error) {
				return Err({
					title: 'Failed to import configuration',
					description: error.message,
					action: { type: 'more-details' as const, error },
				});
			}

			return Ok(data);
		},
	}),
};
