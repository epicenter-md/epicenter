import {
	hashPassword as hashPasswordBetterAuth,
	verifyPassword as verifyPasswordBetterAuth,
} from 'better-auth/crypto';
import type { Brand } from 'wellcrafted/brand';

export type Password = string & Brand<'Password'>;
export type HashedPassword = string & Brand<'HashedPassword'>;

export async function hashPassword(
	password: Password,
): Promise<HashedPassword> {
	return (await hashPasswordBetterAuth(password)) as HashedPassword;
}

export function verifyPassword({
	password,
	hash,
}: { password: Password; hash: HashedPassword }): Promise<boolean> {
	return verifyPasswordBetterAuth({ password, hash });
}
