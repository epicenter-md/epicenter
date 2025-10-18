import js from '@eslint/js';
import type { Linter } from 'eslint';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

/**
 * Base ESLint configuration that includes Prettier integration and ignore patterns.
 * This should be included in all configurations to ensure consistent formatting.
 */
export const base = [
	{
		ignores: [
			// Build outputs
			'**/dist/**',
			'**/build/**',
			'**/.svelte-kit/**',
			'**/source-target/**',
			'**/target/**',
			'**/.turbo/**',

			// Dependencies
			'**/node_modules/**',

			// Generated files
			'**/*.min.js',
			'**/*.min.css',
			'**/generated/**',

			// Test coverage
			'**/coverage/**',

			// IDE and OS files
			'**/.DS_Store',
			'**/.idea/**',
			'**/.vscode/**',

			// Temporary files
			'**/*.log',
			'**/tmp/**',
			'**/temp/**',

			// Package manager files
			'**/pnpm-lock.yaml',
			'**/package-lock.json',
			'**/yarn.lock',
		],
	},
	prettier,
] satisfies Linter.Config[];

/**
 * Complete ESLint configuration for Svelte applications.
 * Includes base config plus Svelte-specific rules and Prettier compatibility.
 */
export const svelteConfig = ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		// See more details at: https://typescript-eslint.io/packages/parser/
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'], // Add support for additional file extensions, such as .svelte
				parser: ts.parser,
			},
		},
	},
);
