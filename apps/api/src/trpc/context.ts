import type { CloudflareEnv } from '@repo/constants/cloudflare';
import { db } from '@repo/db';
import type { Context } from 'hono';
import type { Session, User } from '../lib/auth';

export function createContext(
	c: Context<{
		Bindings: CloudflareEnv;
		Variables: {
			user: User | null;
			session: Session | null;
		};
	}>,
) {
	return {
		user: c.var.user,
		session: c.var.session,
		db: db(c.env),
		env: c.env,
	} as const;
}

export type TRPCContext = ReturnType<typeof createContext>;
