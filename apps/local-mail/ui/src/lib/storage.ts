import { createEpicenter } from '@epicenter/app';

/** Local Mail's browser-scoped storage capability. Semantic Gmail calls remain in `api.ts`. */
export const epicenter = createEpicenter({
	appId: 'so.epicenter.local-mail',
});
