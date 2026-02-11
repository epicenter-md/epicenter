#!/usr/bin/env bun

/**
 * @fileoverview Clean script for Epicenter monorepo
 *
 * Removes build artifacts, caches, and node_modules across the monorepo.
 *
 * Usage:
 *   bun run clean        # Remove build artifacts, caches, node_modules
 *   bun run clean --nuke # Above + Rust targets + dev webview cache (full reset)
 */

import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { workspaces } from '../package.json';

const isNuke = process.argv.includes('--nuke');

// Only clear webview cache for dev apps, never production (would delete user's API keys/settings)
const DEV_BUNDLE_ID = 'com.tauri.dev';

const subDirs = [
	// Build outputs
	'.svelte-kit',
	'.astro',
	'.wxt',
	'.output',
	'.vercel',
	'.build',
	'dist',
	// Caches
	'.wrangler',
	'.mf',
	// Tauri generated files (no-op for non-Tauri workspaces)
	'src-tauri/gen',
	// Dependencies (includes nested caches like node_modules/.vite)
	'node_modules',
	// Nuke-only: Rust compilation cache (several GB, takes minutes to rebuild)
	...(isNuke ? ['src-tauri/target'] : []),
] as const;

async function main() {
	console.log(
		isNuke
			? '💥 NUKE MODE: Cleaning everything including Rust target...\n\n⚠️  Warning: Rust recompilation will take several minutes!\n'
			: '🧹 Cleaning Epicenter monorepo...\n',
	);

	// Discover all monorepo package roots from workspace config
	const packageRoots = workspaces.packages.flatMap((pattern) => [
		...new Bun.Glob(pattern).scanSync({ onlyFiles: false }),
	]);

	const dirsToRemove = [
		'.turbo',
		'node_modules',
		...packageRoots.flatMap((root) =>
			subDirs.map((subDir) => join(root, subDir)),
		),
	];

	// Clean repo directories
	console.log('Removing build artifacts and node_modules...');
	await Promise.all(
		dirsToRemove.map((path) => rm(path, { recursive: true, force: true })),
	);
	console.log(`  ✓ Processed ${dirsToRemove.length} directories\n`);

	// Nuke mode: also clear dev app webview cache (contains localStorage, so never touch production)
	if (isNuke) {
		const home = homedir();

		let devCacheDirs: string[];
		switch (process.platform) {
			case 'darwin':
				devCacheDirs = [join(home, 'Library/WebKit', DEV_BUNDLE_ID)];
				break;
			case 'linux':
				devCacheDirs = [
					join(home, '.local/share', DEV_BUNDLE_ID),
					join(home, '.cache', DEV_BUNDLE_ID),
				];
				break;
			case 'win32':
				devCacheDirs = [
					join(
						process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'),
						DEV_BUNDLE_ID,
						'EBWebView',
					),
				];
				break;
			default:
				devCacheDirs = [];
		}

		if (devCacheDirs.length) {
			console.log('Clearing dev app webview cache...');
			await Promise.all(
				devCacheDirs.map((p) => rm(p, { recursive: true, force: true })),
			);
			console.log(`  ✓ Cleared ${DEV_BUNDLE_ID} cache\n`);
		}
	}

	console.log('✨ Clean complete!\n');

	// Reinstall dependencies
	console.log('📦 Installing dependencies...\n');
	await Bun.spawn(['bun', 'install'], {
		stdio: ['inherit', 'inherit', 'inherit'],
	}).exited;
}

main().catch(console.error);
