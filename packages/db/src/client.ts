import { neon } from '@neondatabase/serverless';
import type { CloudflareEnv } from '@repo/constants/cloudflare';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

export const db = (env: CloudflareEnv) => {
	const sql = neon(env.DATABASE_URL);
	return drizzle({ client: sql, schema });
};
