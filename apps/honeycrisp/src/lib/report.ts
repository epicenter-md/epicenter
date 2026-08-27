/**
 * Where work nobody awaited goes when it fails.
 *
 * A sync retry, a discarded superseded replica: neither has a caller holding a
 * promise, so a failure has nowhere to be returned to and warning is the whole
 * of the handling.
 *
 * This was a `reportBackgroundError` field threaded through the application,
 * the sync attachment and three state modules. It had exactly one production
 * value, this one, and its only other value was a no-op inside a test that
 * never reached a line which called it. A parameter with one value is not a
 * seam, so the seam is gone and the places that report import this.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('honeycrisp');

/**
 * The failure this module logs. The `cause` is `unknown` because these arrive
 * from rejected promises and transport callbacks nobody awaited, and a tagged
 * variant gives the log event a stable `name` to filter on rather than a
 * message string minted at the call site.
 */
export const HoneycrispBackgroundError = defineErrors({
	BackgroundWorkFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Honeycrisp background work failed',
		cause,
	}),
});
export type HoneycrispBackgroundError = InferErrors<
	typeof HoneycrispBackgroundError
>;

export function reportBackgroundError(cause: unknown): void {
	log.warn(HoneycrispBackgroundError.BackgroundWorkFailed({ cause }));
}

/**
 * Where the folder reports its own trouble (ADR-0271).
 *
 * A full disk, a read-only volume, an external drive somebody unplugged: the
 * store is unaffected by every one of them, because the folder is derived and
 * the next pass rewrites whatever this one could not. So a mirror failure is
 * a warning about a folder and never an error about data, and it is the same
 * severity for the same reason background work is.
 */
export const mirrorLog = {
	error: (cause: unknown) => reportBackgroundError(cause),
	warn: (cause: unknown) => reportBackgroundError(cause),
	info: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
};
