import { vitePreprocess } from '@astrojs/svelte';

export default {
	preprocess: vitePreprocess(),
	kit: {
		alias: {
			'#': '../../packages/ui/src',
		},
	},
};
