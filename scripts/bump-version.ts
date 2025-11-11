#!/usr/bin/env node

/**
 * @fileoverview Version bumping utility for Whispering monorepo
 *
 * This script updates version numbers across all necessary files in the project:
 * - Root package.json
 * - App package.json
 * - Tauri configuration
 * - Cargo.toml
 * - Cargo.lock (via cargo update)
 * - packages/constants/src/versions.ts
 *
 * Usage: bun run bump-version <new-version>
 * Example: bun run bump-version 7.0.1
 */

import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';

/** Extract new version from command line arguments */
const newVersion = process.argv[2];
if (!newVersion) {
	console.error('Usage: node scripts/bump-version.js <new-version>');
	console.error('Example: node scripts/bump-version.js 6.6.0');
	process.exit(1);
}

/**
 * Validate semantic version format
 * Ensures version follows X.Y.Z pattern where X, Y, Z are numbers
 */
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
	console.error(
		'Invalid version format. Use semantic versioning (e.g., 6.6.0)',
	);
	process.exit(1);
}

/**
 * Configuration for files that need version updates
 */
const files = [
	{ path: 'package.json', type: 'json' },
	{ path: 'apps/whispering/package.json', type: 'json' },
	{ path: 'apps/whispering/src-tauri/tauri.conf.json', type: 'json' },
	{ path: 'apps/whispering/src-tauri/Cargo.toml', type: 'toml' },
	{ path: 'packages/constants/src/versions.ts', type: 'ts' },
] satisfies { path: string; type: 'json' | 'toml' | 'ts' }[];

/** Track the current version before updating */
let oldVersion: string | null = null;

/**
 * Process each file and update its version
 */
for (const { path, type } of files) {
	const fullPath = join(process.cwd(), path);
	const content = await fs.readFile(fullPath, 'utf-8');

	if (type === 'json') {
		// Handle JSON files (package.json, tauri.conf.json)
		const json = JSON.parse(content);
		if (!oldVersion && json.version) {
			oldVersion = json.version;
		}
		json.version = newVersion;
		// Preserve formatting with tabs and trailing newline
		await fs.writeFile(fullPath, `${JSON.stringify(json, null, '\t')}\n`);
	} else if (type === 'toml') {
		// Handle TOML files (Cargo.toml) with regex replacement
		const versionRegex = /^version\s*=\s*"[\d.]+"/m;
		const match = content.match(versionRegex);
		if (match && !oldVersion) {
			oldVersion = match[0].match(/"([\d.]+)"/)?.[1] ?? null;
		}
		const updated = content.replace(versionRegex, `version = "${newVersion}"`);
		await fs.writeFile(fullPath, updated);
	} else if (type === 'ts') {
		// Handle TypeScript files (versions.ts) with regex replacement
		const versionRegex = /whispering:\s*'[\d.]+'/;
		const match = content.match(versionRegex);
		if (match && !oldVersion) {
			oldVersion = match[0].match(/'([\d.]+)'/)?.[1] ?? null;
		}
		const updated = content.replace(
			versionRegex,
			`whispering: '${newVersion}'`,
		);
		await fs.writeFile(fullPath, updated);
	}

	console.log(`✅ Updated ${path}`);
}

/**
 * Update Cargo.lock by running cargo update
 */
try {
	console.log('\n🔄 Updating Cargo.lock...');
	await $`cd apps/whispering/src-tauri && cargo update -p whispering`;
	console.log('✅ Updated Cargo.lock');
} catch (error) {
	console.error('❌ Failed to update Cargo.lock:', extractErrorMessage(error));
	console.log(
		'   You may need to run: cd apps/whispering/src-tauri && cargo update -p whispering',
	);
}

/**
 * Display summary
 */
console.log(`\n📦 Version bumped from ${oldVersion} to ${newVersion}`);

/**
 * Commit the version changes
 */
try {
	console.log('\n📝 Committing version changes...');
	await $`git add -A`;
	await $`git commit -m "chore: bump version to ${newVersion}"`;
	console.log('✅ Committed changes');
} catch (error) {
	console.error('❌ Failed to commit changes:', extractErrorMessage(error));
	process.exit(1);
}

/**
 * Create git tag with v prefix (force overwrite if exists)
 */
try {
	console.log('\n🏷️  Creating git tag...');
	// Force create tag locally (overwrites if exists)
	await $`git tag -f v${newVersion}`;
	console.log(`✅ Created tag v${newVersion}`);
} catch (error) {
	console.error('❌ Failed to create tag:', extractErrorMessage(error));
	process.exit(1);
}

/**
 * Push to remote (both commits and tags)
 * Force push tag to overwrite if it exists on remote
 */
try {
	console.log('\n⬆️  Pushing to remote...');
	await $`git push`;
	await $`git push origin v${newVersion} --force`;
	console.log('✅ Pushed to remote');
} catch (error) {
	console.error('❌ Failed to push to remote:', extractErrorMessage(error));
	process.exit(1);
}

console.log(`\n🎉 Release ${newVersion} complete!`);

/**
 * Extract error message from unknown error type
 */
function extractErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
