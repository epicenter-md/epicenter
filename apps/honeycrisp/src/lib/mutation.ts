import { toast } from '@epicenter/ui/sonner';
import { extractErrorMessage } from 'wellcrafted/error';

/**
 * Run a mutation triggered by an event, and present any storage failure.
 *
 * Takes a function rather than a promise now that every write is synchronous.
 * The store either committed or it did not by the time this returns, so there
 * is nothing to await and nothing that can settle after the handler is gone.
 */
export function runHoneycrispMutation(
	mutation: () => void,
	title: string,
): void {
	try {
		mutation();
	} catch (cause) {
		toast.error(title, { description: extractErrorMessage(cause), id: title });
	}
}
