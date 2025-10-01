import type { Brand } from 'wellcrafted/brand';

/**
 * Branded type for template strings that contain {{variable}} placeholders
 */
export type TemplateString = string & Brand<'TemplateString'>;

/**
 * Type guard/assertion to mark a string as a template
 */
export function asTemplateString(str: string): TemplateString {
	return str as TemplateString;
}

/**
 * Interpolate template variables in a string
 * Replaces {{key}} with the corresponding value from the variables object
 *
 * @example
 * interpolateTemplate('Hello {{name}}!', { name: 'World' }) // 'Hello World!'
 * interpolateTemplate('{{outputFolder}}/{{recordingId}}.wav', {
 *   outputFolder: '/Users/jane/Recordings',
 *   recordingId: 'abc123'
 * }) // '/Users/jane/Recordings/abc123.wav'
 */
export function interpolateTemplate(
	template: TemplateString,
	variables: Record<string, string | number>,
): string {
	let result: string = template;

	for (const [key, value] of Object.entries(variables)) {
		const pattern = new RegExp(`{{${key}}}`, 'g');
		result = result.replace(pattern, String(value));
	}

	return result;
}
