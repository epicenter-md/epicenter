/**
 * Browser implementation of the auxiliary-window event seam. Whispering's
 * hosted SPA renders its recording pill in-page, so it has no second webview to
 * message. The methods keep shared event declarations platform-neutral while
 * doing no work in the browser build.
 */

type EventCallback<T> = (event: { payload: T }) => void;
type Unlisten = () => void;

export function defineWindowEvent<T>(_name: string) {
	return {
		emit: async (_payload: T): Promise<void> => {},
		emitTo: async (_label: string, _payload: T): Promise<void> => {},
		listen:
			async (_handler: EventCallback<T>): Promise<Unlisten> =>
			() => {},
	};
}

export function defineWindowSignal(_name: string) {
	return {
		emit: async (): Promise<void> => {},
		listen:
			async (_handler: () => void): Promise<Unlisten> =>
			() => {},
	};
}
