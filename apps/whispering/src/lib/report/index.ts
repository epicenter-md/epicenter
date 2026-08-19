import { toast as sonner } from '@epicenter/ui/sonner';
import { nanoid } from 'nanoid/non-secure';
import type { AnyTaggedError } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { osNotify } from '#platform/os-notify';
import { moreDetailsDialog } from '$lib/components/MoreDetailsDialog.svelte';
import { humanize } from './humanize';

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

const log = createLogger('whispering/report');

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

	// A problem is logged as its tagged cause, so the console event carries the
	// variant `name` and its captured fields. Everything else is an announcement
	// with no error to name, which is exactly what `info` is for. `loading` says
	// nothing: its resolve or reject is the event worth recording.
	if (level === 'error' && notice.cause) {
		log.error(notice.cause);
	} else if (level !== 'loading') {
		log.info(
			notice.title ?? notice.cause?.message ?? '',
			id !== undefined ? { ...notice, id } : notice,
		);
	}

	sonner[level](title, {
		id,
		description,
		descriptionClass: 'line-clamp-6',
		duration: TOAST_DURATION[level],
		action: notice.action ?? defaultMoreDetailsAction(level, notice.cause),
	});

	if (level === 'error' && !document.hasFocus()) {
		void osNotify(title, description);
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
