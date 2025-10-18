import { env } from '@repo/constants/node';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/schema/*',
	out: './src/migrations',
	dialect: 'postgresql',
	dbCredentials: { url: env.DATABASE_URL },
});
