import { toast as sonner } from '@epicenter/ui/sonner';
import { nanoid } from 'nanoid/non-secure';
import type { AnyTaggedError } from 'wellcrafted/error';
import { consoleSink, type LogEvent } from 'wellcrafted/logger';
import { environment } from '#runtime';
import { moreDetailsDialog } from '$lib/components/MoreDetailsDialog.svelte';
import { humanize } from './humanize';
import { SOURCE } from './log';

export { log } from './log';

export type NoticeAction = {
	label: string;
	onClick: () => void | Promise<void>;
};

export type Notice = {
	title?: string;
	description?: string;
	action?: NoticeAction;
	cause?: AnyTaggedError;
};

export type Problem = Notice & { cause: AnyTaggedError };

/**
 * A standing notice that persists until granted/resolved and is deduped by a
 * caller-owned `id`, so the same condition (e.g. a missing OS permission) shows
 * one toast no matter how often the check re-runs. Dismiss with `report.dismiss`.
 */
export type StandingNotice = Notice & { id: string };

type Level = 'error' | 'success' | 'info' | 'warning' | 'loading';


const TOAST_DURATION = {
	error: Number.POSITIVE_INFINITY,
	success: 3000,
	info: 4000,
	warning: Number.POSITIVE_INFINITY,
	loading: Number.POSITIVE_INFINITY,
} as const;

// ── Public API ────────────────────────────────────────────────────────────

export const report = {
	error(problem: Problem): void {
		emit('error', problem);
	},
	success(notice: Notice): void {
		emit('success', notice);
	},
	info(notice: Notice): void {
		emit('info', notice);
	},
	/**
	 * A persistent, dedup-by-id warning that stays up until the condition clears.
	 * Re-emitting with the same `id` updates the one toast rather than stacking;
	 * call `dismiss(id)` once the condition resolves.
	 */
	warning(notice: StandingNotice): void {
		emit('warning', notice, notice.id);
	},
	/** Dismiss a standing notice (or a loading notice) by its id. */
	dismiss(id: string): void {
		sonner.dismiss(id);
	},
	loading(notice: Notice) {
		const id = nanoid();
		emit('loading', notice, id);
		return {
			/** Resolve the loading notice as a success notice. */
			resolve: (r: Notice) => emit('success', r, id),
			/** Resolve the loading notice as an error notice. */
			reject: (r: Problem) => emit('error', r, id),
		};
	},
};

// ── Internals ─────────────────────────────────────────────────────────────

/**
 * Fan a notice out to the console, toast, and OS-notification surfaces.
 *
 * `id` is the sonner toast correlation id: pass it from the loading family so
 * resolve/reject can target the same toast. Omit it for one-shot
 * error/success/info reports.
 */
function emit(level: Level, notice: Notice, id?: string): void {
	const title =
		(notice.title ?? humanize(notice.cause?.name ?? '')) || 'Notice';
	const description = notice.description ?? notice.cause?.message;

	if (level !== 'loading') {
		consoleSink({
			ts: Date.now(),
			level: level === 'error' ? 'error' : 'info',
			source: SOURCE,
			message: notice.title ?? notice.cause?.message ?? '',
			data: id !== undefined ? { ...notice, id } : notice,
		} satisfies LogEvent);
	}

	sonner[level](title, {
		id,
		description,
		descriptionClass: 'line-clamp-6',
		duration: TOAST_DURATION[level],
		action: notice.action ?? defaultMoreDetailsAction(level, notice.cause),
	});

	if (level === 'error' && !document.hasFocus()) {
		environment.notifications(title, description);
	}
}

function defaultMoreDetailsAction(
	level: Level,
	cause: AnyTaggedError | undefined,
): NoticeAction | undefined {
	if (level !== 'error' || !cause) return undefined;
	return {
		label: 'More details',
		onClick: () =>
			moreDetailsDialog.open({
				title: 'More details',
				description: 'The following is the raw error message.',
				content: cause,
			}),
	};
}
