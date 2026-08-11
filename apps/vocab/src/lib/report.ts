/**
 * Where work nobody awaited goes when it fails.
 *
 * A sync dial that could not reach the network, a discard on the way to
 * adopting a replaced document: neither has a caller holding a promise, so a
 * failure has nowhere to be returned to and telling the person is the whole of
 * the handling.
 *
 * This was a `reportBackgroundError` field threaded through the application,
 * the browser opener and the chat registry. It had exactly one production
 * value, this one. A parameter with one value is not a seam, so the seam is
 * gone and the places that report import this.
 */

import { toast } from '@epicenter/ui/sonner';
import { extractErrorMessage } from 'wellcrafted/error';

export function reportBackgroundError(cause: unknown): void {
	toast.error('Vocab background work failed', {
		description: extractErrorMessage(cause),
	});
}
