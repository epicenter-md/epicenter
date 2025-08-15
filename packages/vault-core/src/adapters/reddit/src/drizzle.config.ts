import { defineConfig } from 'drizzle-kit';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to this module so they work regardless of process CWD
// Migrations live at the adapter root (../migrations), not inside src/
// TODO custom migration format/process that doesn't rely on node:fs (??)
const out = fileURLToPath(new URL('../migrations', import.meta.url));
const schema = fileURLToPath(new URL('./schema.ts', import.meta.url)) as string;

export default defineConfig({
	// Using sqlite dialect; schema is in this package
	dialect: 'sqlite',
	casing: 'snake_case',
	strict: true,
	out,

	// Use absolute schema path for CLI compatibility as well
	schema,

	// Every adapter *must* have a unique migrations table name, in order for everything to play nicely with other adapters
	migrations: {
		table: 'reddit_migrations',
	},
});
