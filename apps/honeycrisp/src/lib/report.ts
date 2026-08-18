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
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('honeycrisp');

export function reportBackgroundError(cause: unknown): void {
	log.warn(new Error('Honeycrisp background work failed', { cause }));
}
