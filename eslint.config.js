import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import tsParser from '@typescript-eslint/parser';
// eslint.config.js
// @ts-nocheck
import { defineConfig } from 'eslint/config';
import sveltePlugin from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

/**
 * Resolve a path relative to this config file.
 */
const fromConfig = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Load root package.json and gather workspace directories.
 * Supports simple patterns like "apps/*" and "packages/*".
 */
function resolveWorkspaceDirs() {
	const rootPkgPath = fromConfig('./package.json');
	const dirs = new Set();

	try {
		const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
		const patterns = Array.isArray(pkg.workspaces)
			? pkg.workspaces
			: Array.isArray(pkg.workspaces?.packages)
				? pkg.workspaces.packages
				: [];

		for (const pat of patterns) {
			// Only handle simple "<base>/*" patterns for monorepos
			const m = /^(.+)\/\*$/.exec(pat);
			if (m) {
				const base = path.resolve(path.dirname(rootPkgPath), m[1]);
				if (fs.existsSync(base)) {
					const entries = fs.readdirSync(base, { withFileTypes: true });
					for (const ent of entries) {
						if (ent.isDirectory() && !ent.name.startsWith('.')) {
							dirs.add(path.join(base, ent.name));
						}
					}
				}
				continue;
			}

			// If it's a direct directory path, add if exists
			const abs = path.resolve(path.dirname(rootPkgPath), pat);
			if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
				dirs.add(abs);
			}
		}
	} catch {
		// ignore
	}

	return Array.from(dirs);
}

/**
 * Build ignore configs:
 * - root .gitignore
 * - per-workspace .gitignore (from package.json workspaces)
 * - current working directory .gitignore (when running inside a workspace)
 */
function buildIgnoreConfigs() {
	const ignores = [];

	// Root .gitignore
	const rootGitignore = fromConfig('./.gitignore');
	if (fs.existsSync(rootGitignore)) {
		ignores.push(includeIgnoreFile(rootGitignore, 'root .gitignore'));
	}

	// Workspace .gitignore files
	for (const wsDir of resolveWorkspaceDirs()) {
		const gi = path.join(wsDir, '.gitignore');
		if (fs.existsSync(gi)) {
			ignores.push(
				includeIgnoreFile(
					gi,
					`workspace .gitignore: ${path.relative(process.cwd(), gi)}`,
				),
			);
		}
	}

	// CWD .gitignore (when run via Turbo inside a workspace)
	const cwdGitignore = path.resolve(process.cwd(), '.gitignore');
	if (fs.existsSync(cwdGitignore)) {
		ignores.push(includeIgnoreFile(cwdGitignore, 'cwd .gitignore'));
	}

	return ignores;
}

export default defineConfig([
	// Ignore wiring
	...buildIgnoreConfigs(),

	// Svelte-only linting with TS in <script> via @typescript-eslint/parser
	{
		name: 'svelte',
		files: ['**/*.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tsParser, // enable TypeScript in Svelte <script> blocks
				extraFileExtensions: ['.svelte'],
				ecmaVersion: 'latest',
				sourceType: 'module',
			},
		},
		plugins: {
			svelte: sveltePlugin,
		},
	},
]);
