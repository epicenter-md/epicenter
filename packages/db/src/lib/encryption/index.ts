import type { CloudflareEnv } from '@repo/constants/cloudflare';
import {
	hashToBase64,
	symmetricDecrypt,
	symmetricEncrypt,
} from 'better-auth/crypto';
import type { Brand } from 'wellcrafted/brand';

/**
 * Encrypted data type for type safety
 */
export type EncryptedData = string & Brand<'EncryptedData'>;

/**
 * Creates a set of encryption utilities for secure data encryption and decryption.
 *
 * This generic factory pattern allows you to create encryption utilities for storing user
 * information by providing the necessary configuration parameters.
 *
 * @example
 * ```typescript
 * // Create encryption utilities for assistant configuration
 * const encryptionUtils = await createEncryptionUtils({
 *   userId: 'user-123',
 *   env: ctx.env,
 *   purpose: 'assistant-config-password-encryption'
 * });
 *
 * // Use the utilities
 * const encrypted = await encryptionUtils.encrypt('mySecret123');
 * const decrypted = await encryptionUtils.decrypt(encrypted);
 * ```
 *
 * @param params - Configuration object
 * @param params.userId - The user's unique identifier
 * @param params.env - Cloudflare environment containing BETTER_AUTH_SECRET
 * @param params.purpose - Purpose string for key derivation (e.g., 'assistant-config', 'user-data', 'authentication')
 * @returns Object containing encrypt and decrypt functions
 */
export async function createEncryptionUtils({
	userId,
	env,
	purpose,
}: {
	userId: string;
	env: Pick<CloudflareEnv, 'BETTER_AUTH_SECRET'>;
	purpose: string;
}) {
	// Derive the key once during factory creation
	const masterKey = env.BETTER_AUTH_SECRET;
	const keyMaterial = `${masterKey}:${purpose}:user:${userId}`;
	const key = await hashToBase64(keyMaterial);

	return {
		/**
		 * Encrypts data for secure storage.
		 *
		 * @param data - The plain text data to encrypt
		 * @returns Encrypted data
		 */
		async encrypt(data: string): Promise<EncryptedData> {
			const encrypted = await symmetricEncrypt({ key, data });
			return encrypted as EncryptedData;
		},

		/**
		 * Decrypts data for use.
		 *
		 * @param encryptedData - The encrypted data from storage
		 * @returns The decrypted plain text data
		 */
		async decrypt(encryptedData: EncryptedData): Promise<string> {
			return symmetricDecrypt({ key, data: encryptedData });
		},
	};
}
