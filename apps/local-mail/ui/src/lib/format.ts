// Presentation helpers for the triage surface. None of this invents mail state;
// it only makes Gmail's own bytes (label ids, epoch dates, RFC 5322 senders)
// scannable for a human.

const FRIENDLY_LABELS: Record<string, string> = {
	INBOX: 'Inbox',
	UNREAD: 'Unread',
	STARRED: 'Starred',
	IMPORTANT: 'Important',
	SENT: 'Sent',
	DRAFT: 'Draft',
	SPAM: 'Spam',
	TRASH: 'Trash',
	CHAT: 'Chat',
	CATEGORY_PERSONAL: 'Personal',
	CATEGORY_SOCIAL: 'Social',
	CATEGORY_PROMOTIONS: 'Promotions',
	CATEGORY_UPDATES: 'Updates',
	CATEGORY_FORUMS: 'Forums',
};

/** Turn a Gmail label id (and its mirrored name) into a human chip label. */
export function labelDisplayName(id: string, name?: string | null): string {
	return FRIENDLY_LABELS[id] ?? name ?? id;
}

/** Labels that are triage machinery or shown another way, not row chips. */
const HIDDEN_ROW_LABELS = new Set([
	'UNREAD',
	'INBOX',
	'SENT',
	'DRAFT',
	'STARRED',
]);

export function chipLabelIds(labelIds: string[]): string[] {
	return labelIds.filter((id) => !HIDDEN_ROW_LABELS.has(id));
}

/** Strip the address, keep the display name: "Jane Doe <j@x.com>" -> "Jane Doe". */
export function senderName(sender: string | null): string {
	if (!sender) return '(unknown sender)';
	const match = sender.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
	if (match) return match[1] as string;
	return sender.replace(/[<>]/g, '').trim() || sender;
}

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&nbsp;': ' ',
};

/** Gmail snippets arrive with HTML entities; decode the common ones for display. */
export function decodeSnippet(snippet: string | null): string {
	if (!snippet) return '';
	return snippet
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/[‌ ]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Compact list timestamp: time-of-day today, month/day this year, else short date. */
export function shortDate(epochMs: number | null): string {
	if (!epochMs) return '';
	const date = new Date(epochMs);
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	if (sameDay) {
		return new Intl.DateTimeFormat(undefined, {
			hour: 'numeric',
			minute: '2-digit',
		}).format(date);
	}
	if (date.getFullYear() === now.getFullYear()) {
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
		}).format(date);
	}
	return new Intl.DateTimeFormat(undefined, {
		year: '2-digit',
		month: 'numeric',
		day: 'numeric',
	}).format(date);
}

/** Full timestamp for the detail header. */
export function fullDate(
	epochMs: number | null,
	fallback: string | null,
): string {
	if (!epochMs) return fallback ?? '';
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(epochMs));
}

/** "2m ago" style relative time for the sync status. */
export function relativeTime(iso: string | null): string {
	if (!iso) return 'never';
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return 'never';
	const seconds = Math.round((Date.now() - then) / 1000);
	if (seconds < 10) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
