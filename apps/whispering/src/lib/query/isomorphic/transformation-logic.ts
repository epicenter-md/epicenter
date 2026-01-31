export function applySimplePunctuation(input: string): string {
	let output = input;
	const replacements = [
		{ pattern: /(?:\s+|^)(?:period|full stop)/gi, replacement: '.' },
		{ pattern: /(?:\s+|^)comma/gi, replacement: ',' },
		{ pattern: /(?:\s+|^)question mark/gi, replacement: '?' },
		{
			pattern: /(?:\s+|^)(?:exclamation mark|exclamation point)/gi,
			replacement: '!',
		},
		{ pattern: /(?:\s+|^)colon/gi, replacement: ':' },
		{ pattern: /(?:\s+|^)semicolon/gi, replacement: ';' },
		{ pattern: /(?:\s+|^)(?:new line|newline)/gi, replacement: '\n' },
		{ pattern: /(?:\s+|^)new paragraph/gi, replacement: '\n\n' },
	];

	for (const { pattern, replacement } of replacements) {
		output = output.replace(pattern, replacement);
	}
	return output;
}
