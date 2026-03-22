import { APP_URLS } from '@epicenter/constants/vite';
import {
	createAuthState,
	createTokenStore,
} from '@epicenter/svelte/auth-state';

export const tokenStore = createTokenStore('zhongwen');

export const authState = createAuthState({
	baseURL: APP_URLS.API,
	storagePrefix: 'zhongwen',
	tokenStore,
});
