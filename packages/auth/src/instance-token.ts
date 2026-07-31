/**
 * The single-partition instance bearer secret: generate one, and gate one at
 * boot (self-host; ADR-0075).
 *
 * A self-hosted instance authenticates one operator-supplied static bearer
 * (`INSTANCE_TOKEN`). These are the two PURE pieces of that credential, the ones
 * with no server coupling: {@link generateInstanceToken} mints a strong token and
 * {@link assertStrongToken} is the boot entropy gate. They live in `@epicenter/auth`
 * (not `@epicenter/server`) so a token can be generated and validated without
 * dragging the server graph in: the self-host scripts depend on
 * `@epicenter/auth`, not `@epicenter/server`.
 *
 * The matching RESOLVER side (turn a presented bearer into a principal, the
 * `ResolveBearerPrincipal` a deployment injects) needs the server's `Principal` and
 * `ResolveBearerPrincipal` types, so it stays in `@epicenter/server`.
 * `createEnvTokenResolver` resolves any exact-match bearer to
 * `{ id: INSTANCE_PRINCIPAL_ID }`.
 *
 * Portable (ADR-0066): nothing here names `node:` or touches disk. The token
 * generator uses the Web Crypto `crypto` global (`getRandomValues`, `btoa`), which
 * Bun and Cloudflare Workers expose identically, so the same helper runs in a
 * `gen-token` script and in any runtime.
 */

/**
 * The entropy floor for an operator-supplied `INSTANCE_TOKEN`: at least this many
 * URL-safe characters. 32 base64url chars carry ~192 bits; {@link generateInstanceToken}
 * emits 43 chars (256 bits), comfortably above the floor. An earlier minting
 * design guaranteed 256 bits implicitly; with the operator supplying the secret
 * instead, this gate keeps a fat-fingered `letmein` from silently becoming the
 * box's only credential (ADR-0075).
 */
export const MIN_INSTANCE_TOKEN_CHARS = 32;

/** A high-entropy token is URL-safe characters only (what {@link generateInstanceToken} emits). */
const TOKEN_CHARSET = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Generate a strong instance token: 32 random bytes (256 bits) as base64url, no
 * padding. Portable Web Crypto (`crypto.getRandomValues`, `btoa`), so the same
 * helper runs in `gen-token` and in any runtime. Persists nothing; the operator
 * captures the printed value and supplies it as `INSTANCE_TOKEN`.
 */
export function generateInstanceToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

/**
 * Validate an operator-supplied `INSTANCE_TOKEN` meets the entropy floor, or throw
 * a descriptive `Error` naming why it is too weak. Returns the trimmed token on
 * success. This is a portable length + charset gate (no `node:`, no disk), not a
 * true entropy estimate: it catches the missing, the short, and the obviously
 * hand-typed, which is the regression deleting minting would otherwise open. The
 * caller (a boot entry) catches the throw, fails closed, and points the operator
 * at the `gen-token` helper.
 */
export function assertStrongToken(token: string | undefined): string {
	if (!token?.trim()) {
		throw new Error('INSTANCE_TOKEN is not set.');
	}
	const trimmed = token.trim();
	if (trimmed.length < MIN_INSTANCE_TOKEN_CHARS) {
		throw new Error(
			`INSTANCE_TOKEN is too weak: ${trimmed.length} characters, need at least ${MIN_INSTANCE_TOKEN_CHARS}.`,
		);
	}
	if (!TOKEN_CHARSET.test(trimmed)) {
		throw new Error(
			'INSTANCE_TOKEN has unexpected characters (spaces or control characters); use a high-entropy URL-safe token, not a passphrase.',
		);
	}
	return trimmed;
}
