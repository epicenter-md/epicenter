/**
 * Sanitizes a filename by removing invalid characters and normalizing dashes.
 * Returns 'output' if the result would be empty.
 */
export function sanitizeFilename(filename: string): string {
	return (
		filename
			.replace(/[<>:"/\\|?*]/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '') || 'output'
	);
}
