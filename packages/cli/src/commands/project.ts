/**
 * Project scaffolding command.
 *
 * `epicenter init` creates the project skeleton (config, package.json, gitignore).
 */

import { join } from 'node:path';
import { defineCommand } from '../util/command';
import { output, outputError } from '../util/format-output';

// ─── Init ────────────────────────────────────────────────────────────────────

const CONFIG_TEMPLATE = `// Epicenter workspace configuration.
// Import workspace packages and export configured clients as named exports.
// Each export is auto-discovered by the CLI and daemon.
//
// Example:
//   import { createTabManagerWorkspace } from '@epicenter/tab-manager/workspace';
//   export const tabManager = createTabManagerWorkspace()
//     .withExtension('persistence', filesystemPersistence({ filePath: './data/tab-manager.db' }));

`;

const GITIGNORE_TEMPLATE = `# Epicenter runtime data (persistence, SQLite, logs)
.epicenter/
`;

/**
 * `epicenter init` — scaffold a new Epicenter project.
 *
 * Creates `epicenter.config.ts` (with commented example), `package.json`
 * (with `@epicenter/workspace` dependency), and `.gitignore` (includes `.epicenter/`).
 * Safe to run in an existing directory—skips files that already exist.
 *
 * @example
 * ```bash
 * mkdir my-project && cd my-project
 * epicenter init
 * ```
 */
export const initCommand = defineCommand({
	command: 'init',
	describe: 'Initialize a new Epicenter project',
	builder: (y) =>
		y.option('dir', {
			type: 'string',
			default: '.',
			alias: 'C',
			description: 'Directory to initialize (default: current directory)',
		}),
	handler: async (argv: any) => {
		const dir = argv.dir as string;
		const created: string[] = [];
		const skipped: string[] = [];

		try {
			// epicenter.config.ts
			const configPath = join(dir, 'epicenter.config.ts');
			if (await Bun.file(configPath).exists()) {
				skipped.push('epicenter.config.ts');
			} else {
				await Bun.write(configPath, CONFIG_TEMPLATE);
				created.push('epicenter.config.ts');
			}

			// package.json
			const pkgPath = join(dir, 'package.json');
			if (await Bun.file(pkgPath).exists()) {
				skipped.push('package.json');
			} else {
				const pkg = {
					name: 'epicenter-project',
					private: true,
					dependencies: {
						'@epicenter/workspace': 'latest',
					},
				};
				await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
				created.push('package.json');
			}

			// .gitignore — append if exists, create if not
			const gitignorePath = join(dir, '.gitignore');
			if (await Bun.file(gitignorePath).exists()) {
				const existing = await Bun.file(gitignorePath).text();
				if (existing.includes('.epicenter/')) {
					skipped.push('.gitignore');
				} else {
					await Bun.write(
						gitignorePath,
						existing.trimEnd() + '\n\n' + GITIGNORE_TEMPLATE,
					);
					created.push('.gitignore (appended)');
				}
			} else {
				await Bun.write(gitignorePath, GITIGNORE_TEMPLATE);
				created.push('.gitignore');
			}

			output({ created, skipped });
		} catch (err) {
			outputError(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	},
});
