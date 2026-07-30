import { toast } from '@epicenter/ui/sonner';
import { extractErrorMessage } from 'wellcrafted/error';

/** Own an event-triggered mutation promise and present any storage failure. */
export function runHoneycrispMutation(
	mutation: Promise<unknown>,
	title: string,
): void {
	void mutation.catch((cause) => {
		toast.error(title, {
			description: extractErrorMessage(cause),
			id: title,
		});
	});
}
