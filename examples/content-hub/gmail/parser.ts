import type { gmail_v1 } from 'googleapis';

// ─────────────────────────────────────────────────────────────────────────────
// Email Body Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively extract plain text body from Gmail message payload.
 * Gmail returns body data as base64url encoded strings.
 *
 * The payload can be:
 * - Simple message: body.data contains the content directly
 * - Multipart message: parts[] contains multiple MIME parts
 *
 * We prefer text/plain over text/html for cleaner storage.
 */
export function extractPlainText(
	payload: gmail_v1.Schema$MessagePart | undefined,
): string {
	if (!payload) return '';

	// Check if this part is plain text
	if (payload.mimeType === 'text/plain' && payload.body?.data) {
		return decodeBase64Url(payload.body.data);
	}

	// For multipart messages, search through parts
	if (payload.parts) {
		// First pass: look for text/plain
		for (const part of payload.parts) {
			if (part.mimeType === 'text/plain' && part.body?.data) {
				return decodeBase64Url(part.body.data);
			}
		}

		// Second pass: recurse into nested multipart
		for (const part of payload.parts) {
			if (part.mimeType?.startsWith('multipart/')) {
				const text = extractPlainText(part);
				if (text) return text;
			}
		}

		// Third pass: fall back to text/html if no plain text
		for (const part of payload.parts) {
			if (part.mimeType === 'text/html' && part.body?.data) {
				// Return HTML as-is (could strip tags if needed)
				return decodeBase64Url(part.body.data);
			}
		}
	}

	// Fallback: if body.data exists on the payload itself
	if (payload.body?.data) {
		return decodeBase64Url(payload.body.data);
	}

	return '';
}

/**
 * Decode base64url encoded string to UTF-8.
 * Gmail uses base64url encoding (URL-safe base64 without padding).
 */
function decodeBase64Url(data: string): string {
	// base64url uses - and _ instead of + and /
	// Node's Buffer handles 'base64url' encoding directly
	return Buffer.from(data, 'base64url').toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Header Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a specific header value from message headers.
 */
export function getHeader(
	headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
	name: string,
): string {
	if (!headers) return '';
	const header = headers.find(
		(h) => h.name?.toLowerCase() === name.toLowerCase(),
	);
	return header?.value ?? '';
}

/**
 * Parse email date header into a Date object.
 * Falls back to current date if parsing fails.
 */
export function parseEmailDate(dateString: string): Date {
	if (!dateString) return new Date();

	const parsed = new Date(dateString);
	if (Number.isNaN(parsed.getTime())) {
		return new Date();
	}
	return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Label Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if email has a specific label.
 */
export function hasLabel(
	labels: string[] | null | undefined,
	label: string,
): boolean {
	if (!labels) return false;
	return labels.includes(label);
}

/**
 * Convert labels array to comma-separated string for storage.
 */
export function labelsToString(labels: string[] | null | undefined): string {
	if (!labels || labels.length === 0) return '';
	return labels.join(',');
}
