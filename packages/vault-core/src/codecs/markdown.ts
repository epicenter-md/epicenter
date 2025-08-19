import { defineCodec, type FormatCodec } from '../core/codec';

// Very small deterministic Markdown with YAML headers: ---\n<yaml>\n---\n<body?>
// For now, we do not include a YAML lib; caller will provide headers already normalized.
function headersToYaml(headers: Record<string, unknown>): string {
	const keys = Object.keys(headers).sort();
	const lines = keys.map((k) => `${k}: ${encode(headers[k])}`);
	return lines.join('\n');
}

function encode(v: unknown): string {
	if (v === undefined) return '';
	if (v === null) return 'null';
	if (typeof v === 'string') {
		// Quote only when necessary; keep simple for now
		// Also quote if the scalar looks like a JSON literal (number/boolean/null)
		// to avoid it being parsed as a non-string on re-import.
		if (
			/[:\n#\-]/.test(v) ||
			/^(?:true|false|null)$/i.test(v) ||
			/^-?\d+(?:\.\d+)?$/.test(v)
		)
			return JSON.stringify(v);
		return v;
	}
	return JSON.stringify(v);
}

function parseYaml(text: string): Record<string, unknown> {
	// Minimal, non-compliant YAML parser for simple k: v lines (no arrays/nesting)
	const lines = text.split(/\r?\n/);
	const out: Record<string, unknown> = {};
	for (const line of lines) {
		const idx = line.indexOf(':');
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		const raw = line.slice(idx + 1).trim();
		if (!key) continue;
		// Attempt simple JSON parse for numbers/booleans/quoted strings
		try {
			if (raw === '') out[key] = undefined;
			else out[key] = JSON.parse(raw);
		} catch {
			out[key] = raw;
		}
	}
	return out;
}

// TODO figure out condition for body prop (name based??)
export const markdownFormat = defineCodec({
	id: 'markdown',
	fileExtension: 'md',
	parse(text) {
		const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
		if (!fmMatch) return { body: text };
		const headers = parseYaml(fmMatch[1] ?? '');
		const body = text.slice(fmMatch[0].length);
		return { ...headers, body };
	},
	stringify(rec) {
		const { body, ...rest } = rec ?? ({} as Record<string, unknown>);
		const head = headersToYaml(rest);
		const bodyText =
			typeof body === 'string' ? body : body == null ? '' : String(body);
		const sep = head.length ? `---\n${head}\n---\n` : '';
		// Ensure final newline
		const out = `${sep}${bodyText}`;
		return out.endsWith('\n') ? out : `${out}\n`;
	},
});
