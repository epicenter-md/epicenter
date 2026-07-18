import type { PrincipalId } from '@epicenter/identity';
import { eq } from 'drizzle-orm';
import type { Db } from './create-db.js';
import { user } from './schema/auth.js';

/** Read the hosted account email needed by account-scoped external policy. */
export async function readHostedPrincipalEmail(
	db: Db,
	principalId: PrincipalId,
): Promise<string | null> {
	const [principal] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, principalId))
		.limit(1);
	return principal?.email ?? null;
}
