// prettier.config.js
// Centralized Prettier config. Keep options minimal to avoid changing project style;
// rely on plugins for Svelte/Astro parsing and Tailwind class sorting.
// Boundaries: Biome remains; Prettier handles Svelte/Astro/MD/HTML (approved plan).
export default {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'all',
	printWidth: 80,
	plugins: ['prettier-plugin-svelte', 'prettier-plugin-astro'], // To avoid problems in VS Code, use string instead of imported object directly.
	overrides: [
		{
			files: '*.svelte',
			options: {
				parser: 'svelte',
			},
		},
	],
};
