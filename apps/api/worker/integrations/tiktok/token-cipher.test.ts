import { expect, test } from 'bun:test';
import { createTokenCipher } from './token-cipher.js';

/** 32 bytes, base64url, as the binding supplies. */
function keyOf(fill: number): string {
	const bytes = new Uint8Array(32).fill(fill);
	return Buffer.from(bytes).toString('base64url');
}

const V1 = keyOf(1);
const V2 = keyOf(2);

async function cipherWith(keys: { version: number; base64Key: string }[]) {
	const { data, error } = await createTokenCipher(keys);
	if (error) throw new Error(`cipher construction failed: ${error.message}`);
	return data;
}

test('encrypt then decrypt round-trips a refresh token', async () => {
	const cipher = await cipherWith([{ version: 1, base64Key: V1 }]);
	const secret = 'rft.abc123.a-real-looking-refresh-token';

	const { data: envelope } = await cipher.encrypt(secret);
	const { data: plaintext } = await cipher.decrypt(envelope as string);

	expect(plaintext).toBe(secret);
});

test('the envelope never contains the plaintext and is versioned', async () => {
	const cipher = await cipherWith([{ version: 1, base64Key: V1 }]);
	const secret = 'super-secret-refresh-token';

	const { data: envelope } = await cipher.encrypt(secret);

	expect(envelope).toStartWith('v1.');
	expect(envelope).not.toContain(secret);
	expect(envelope?.split('.')).toHaveLength(3);
});

test('encrypting the same value twice yields different ciphertext (fresh IV)', async () => {
	const cipher = await cipherWith([{ version: 1, base64Key: V1 }]);

	const { data: first } = await cipher.encrypt('same-token');
	const { data: second } = await cipher.encrypt('same-token');

	expect(first).not.toBe(second);
});

test('a tampered ciphertext fails authenticated decryption instead of returning bytes', async () => {
	const cipher = await cipherWith([{ version: 1, base64Key: V1 }]);
	const { data: envelope } = await cipher.encrypt('token');
	const [version, iv, ciphertext] = (envelope as string).split('.');
	// Flip one base64url character in the ciphertext.
	const flipped = ciphertext?.startsWith('A')
		? `B${ciphertext.slice(1)}`
		: `A${(ciphertext as string).slice(1)}`;

	const { data, error } = await cipher.decrypt(`${version}.${iv}.${flipped}`);

	expect(data).toBeNull();
	expect(error?.name).toBe('DecryptionFailed');
});

test('a different key cannot decrypt another key version-1 envelope', async () => {
	const writer = await cipherWith([{ version: 1, base64Key: V1 }]);
	const otherDeployment = await cipherWith([{ version: 1, base64Key: V2 }]);
	const { data: envelope } = await writer.encrypt('token');

	const { error } = await otherDeployment.decrypt(envelope as string);

	expect(error?.name).toBe('DecryptionFailed');
});

test('a malformed envelope is refused without touching crypto', async () => {
	const cipher = await cipherWith([{ version: 1, base64Key: V1 }]);

	for (const bad of [
		'',
		'plaintext-token',
		'v1.only-two',
		'x1.aa.bb',
		'v0.aa.bb',
	]) {
		const { error } = await cipher.decrypt(bad);
		expect(error?.name).toBe('MalformedEnvelope');
	}
});

test('an envelope naming an unconfigured key version fails closed and says which', async () => {
	const rotated = await cipherWith([
		{ version: 1, base64Key: V1 },
		{ version: 2, base64Key: V2 },
	]);
	const { data: v2Envelope } = await rotated.encrypt('token');

	// The old deployment no longer has v2 configured.
	const onlyV1 = await cipherWith([{ version: 1, base64Key: V1 }]);
	const { data, error } = await onlyV1.decrypt(v2Envelope as string);

	expect(data).toBeNull();
	expect(error?.name).toBe('UnknownKeyVersion');
	expect(error).toMatchObject({ version: 2 });
});

test('rotation: the highest configured version encrypts, older versions still decrypt', async () => {
	const beforeRotation = await cipherWith([{ version: 1, base64Key: V1 }]);
	const { data: legacyEnvelope } = await beforeRotation.encrypt('legacy-token');

	const afterRotation = await cipherWith([
		{ version: 1, base64Key: V1 },
		{ version: 2, base64Key: V2 },
	]);

	// New writes go out under v2...
	expect(afterRotation.activeVersion).toBe(2);
	const { data: fresh } = await afterRotation.encrypt('fresh-token');
	expect(fresh).toStartWith('v2.');

	// ...while the row written before the rotation is still readable.
	const { data: legacyPlaintext } = await afterRotation.decrypt(
		legacyEnvelope as string,
	);
	expect(legacyPlaintext).toBe('legacy-token');
});

test('isCurrent reports whether a row still needs re-encrypting forward', async () => {
	const beforeRotation = await cipherWith([{ version: 1, base64Key: V1 }]);
	const { data: legacyEnvelope } = await beforeRotation.encrypt('legacy');

	const afterRotation = await cipherWith([
		{ version: 1, base64Key: V1 },
		{ version: 2, base64Key: V2 },
	]);
	const { data: freshEnvelope } = await afterRotation.encrypt('fresh');

	expect(afterRotation.isCurrent(legacyEnvelope as string)).toBe(false);
	expect(afterRotation.isCurrent(freshEnvelope as string)).toBe(true);
	// Garbage is never "current"; it must not be mistaken for an up-to-date row.
	expect(afterRotation.isCurrent('not-an-envelope')).toBe(false);
});

test('no configured key refuses construction rather than storing tokens in the clear', async () => {
	const { data, error } = await createTokenCipher([]);

	expect(data).toBeNull();
	expect(error?.name).toBe('NoKeyConfigured');
});

test('key material of the wrong length is refused with the reason', async () => {
	const short = Buffer.from(new Uint8Array(16).fill(7)).toString('base64url');

	const { data, error } = await createTokenCipher([
		{ version: 1, base64Key: short },
	]);

	expect(data).toBeNull();
	expect(error?.name).toBe('InvalidKeyMaterial');
	expect(error?.message).toContain('got 16');
});
