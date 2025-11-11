import { safeLookup } from '@repo/shared';

/**
 * MIME type mappings for audio and video files.
 * This is the single source of truth for extension <-> MIME type mappings.
 */
export const MIME_TYPE_MAP = {
	// Audio formats
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	wma: 'audio/x-ms-wma',
	opus: 'audio/opus',
	webm: 'audio/webm',
	// Video formats
	mp4: 'video/mp4',
	avi: 'video/x-msvideo',
	mov: 'video/quicktime',
	wmv: 'video/x-ms-wmv',
	flv: 'video/x-flv',
	mkv: 'video/x-matroska',
	m4v: 'video/mp4',
} as const;

/**
 * Reverse mapping: MIME type → extension.
 * Automatically derived from MIME_TYPE_MAP.
 */
const EXTENSION_MAP = Object.entries(MIME_TYPE_MAP).reduce(
	(acc, [ext, mime]) => {
		// Handle collisions by preferring the first extension
		if (!acc[mime]) {
			acc[mime] = ext;
		}
		return acc;
	},
	{} as Record<string, string>,
);

/**
 * Common MIME type aliases that map to canonical types.
 * Handles variations like 'audio/wave' vs 'audio/wav'.
 */
const MIME_TYPE_ALIASES = {
	'audio/wave': 'audio/wav',
	'audio/x-wav': 'audio/wav',
	'audio/mp3': 'audio/mpeg',
} as const;

/**
 * Get file extension from MIME type.
 * @param mimeType - MIME type (e.g., 'audio/mpeg')
 * @returns Extension without dot (e.g., 'mp3'), or 'wav' as default
 */
export function getExtensionFromMimeType(mimeType: string): string {
	// Normalize MIME type
	const normalized = safeLookup(MIME_TYPE_ALIASES, mimeType) ?? mimeType;
	return EXTENSION_MAP[normalized] ?? 'wav';
}

/**
 * Get MIME type from file extension.
 * @param extension - Extension with or without dot (e.g., 'mp3' or '.mp3')
 * @returns MIME type (e.g., 'audio/mpeg'), or 'application/octet-stream' as default
 */
export function getMimeTypeFromExtension(extension: string): string {
	// Remove leading dot if present
	const ext = extension.startsWith('.') ? extension.slice(1) : extension;
	return safeLookup(MIME_TYPE_MAP, ext) ?? 'application/octet-stream';
}

/**
 * Get MIME type from file path.
 * Desktop-only utility that extracts the extension and looks up the MIME type.
 * @param filePath - Full file path
 * @returns MIME type (e.g., 'audio/mpeg'), or 'application/octet-stream' as default
 */
export async function getMimeTypeFromPath(filePath: string): Promise<string> {
	const { extname } = await import('@tauri-apps/api/path');
	const ext = (await extname(filePath)).toLowerCase();
	return getMimeTypeFromExtension(ext);
}
