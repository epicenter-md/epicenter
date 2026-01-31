export function applySimplePunctuation(input: string): string {
	let output = input;
	const replacements = [
		{ pattern: /(?:\s+|^)(?:period|full stop)\b/gi, replacement: '.' },
		{ pattern: /(?:\s+|^)comma\b/gi, replacement: ',' },
		{ pattern: /(?:\s+|^)question mark\b/gi, replacement: '?' },
		{
			pattern: /(?:\s+|^)(?:exclamation mark|exclamation point)\b/gi,
			replacement: '!',
		},
		{ pattern: /(?:\s+|^)colon\b/gi, replacement: ':' },
		{ pattern: /(?:\s+|^)semicolon\b/gi, replacement: ';' },
		{ pattern: /(?:\s+|^)(?:new line|newline)(?:\s+|$)/gi, replacement: '\n' },
		{ pattern: /(?:\s+|^)new paragraph(?:\s+|$)/gi, replacement: '\n\n' },
	];

	for (const { pattern, replacement } of replacements) {
		output = output.replace(pattern, replacement);
	}
	return output;
}
