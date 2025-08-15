import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	// Using sqlite dialect; schema is in this package
	dialect: 'sqlite',
	casing: 'snake_case',
	strict: true,
	out: './migrations',

	// Schema can stay undefined, since it will be passed at runtime
	// For the sake of migrations, we'll use the actual path
	schema: './src/schema.ts',

	// Every adapter *must* have a unique migrations table name, in order for everything to play nicely with other adapters
	migrations: {
		table: 'reddit_migrations',
	},
});
