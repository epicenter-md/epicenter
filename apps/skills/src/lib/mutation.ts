import { toast } from '@epicenter/ui/sonner';
import { extractErrorMessage } from 'wellcrafted/error';

/**
 * Run a mutation triggered by an event, and present any storage failure.
 *
 * Takes a function rather than a promise, because every write is synchronous:
 * the store either committed or it did not by the time this returns, so there
 * is nothing to await and nothing that can settle after the handler is gone.
 *
 * It exists because a refused write used to arrive as a rejected promise that
 * `void` quietly swallowed. The same refusal now throws where the click
 * happened, which is only an improvement if somebody catches it and says so.
 */
export function runSkillsMutation(mutation: () => void, title: string): void {
	try {
		mutation();
	} catch (cause) {
		toast.error(title, { description: extractErrorMessage(cause), id: title });
	}
}
