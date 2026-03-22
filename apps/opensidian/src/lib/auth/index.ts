import { APP_URLS } from '@epicenter/constants/vite';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { ws } from '$lib/workspace';
import { createAuthState } from '@epicenter/svelte/auth-state';

export { tokenStore } from './token-store';
import { tokenStore } from './token-store';

export const authState = createAuthState({
	baseURL: APP_URLS.API,
	storagePrefix: 'opensidian',
	tokenStore,
	async onSignedIn(encryptionKey) {
		await ws.activateEncryption(base64ToBytes(encryptionKey));
		ws.extensions.sync.reconnect();
	},
	async onSignedOut() {
		await ws.deactivateEncryption();
		ws.extensions.sync.reconnect();
	},
});
