import { resolve } from 'node:path';
import type { EpicenterConfig } from '../core/epicenter';

/**
 * Load the epicenter configuration from the specified directory
 * Looks for epicenter.config.ts or epicenter.config.js
 *
 * @param configDir - Directory containing epicenter.config.ts
 * @returns Object containing the epicenter configuration and config file path
 * @throws Error if no config file is found or if the config is invalid
 */
export async function loadEpicenterConfig(
	configDir: string,
): Promise<{ config: EpicenterConfig; configPath: string }> {
	// Try different config file extensions
	const configFiles = [
		'epicenter.config.ts',
		'epicenter.config.js',
		'epicenter.config.mjs',
		'epicenter.config.cjs',
	];

	let configPath: string | null = null;
	for (const fileName of configFiles) {
		const filePath = resolve(configDir, fileName);
		const file = Bun.file(filePath);
		if (await file.exists()) {
			configPath = filePath;
			break;
		}
	}

	if (!configPath) {
		throw new Error(
			`No epicenter config file found in ${configDir}.\n` +
				`Expected one of: ${configFiles.join(', ')}`,
		);
	}

	// Dynamically import the config file
	// bun --watch will restart process on changes, ensuring fresh import
	try {
		const configModule = await import(configPath);
		const config = configModule.default || configModule;

		// Validate the config has required properties
		if (!config.id || typeof config.id !== 'string') {
			throw new Error('Epicenter config must have a valid string id');
		}

		if (!Array.isArray(config.workspaces)) {
			throw new Error('Epicenter config must have a workspaces array');
		}

		return { config, configPath };
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(
				`Failed to load epicenter config from ${configPath}: ${error.message}`,
			);
		}
		throw error;
	}
}
