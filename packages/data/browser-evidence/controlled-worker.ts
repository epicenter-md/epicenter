import '@epicenter/data/browser-worker';

import { CONTROL_CHANNEL } from './contract.js';

const scope = globalThis as typeof globalThis & {
	name?: string;
	close(): void;
};
const workerName = scope.name ?? '';
const control = new BroadcastChannel(CONTROL_CHANNEL);

control.onmessage = ({ data: message }) => {
	if (
		typeof message !== 'object' ||
		message === null ||
		!('type' in message) ||
		message.type !== 'terminate' ||
		!('workerName' in message) ||
		message.workerName !== workerName
	)
		return;
	control.postMessage({ type: 'terminating', workerName });
	setTimeout(() => {
		control.close();
		scope.close();
	}, 0);
};
