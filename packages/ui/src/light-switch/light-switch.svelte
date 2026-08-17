<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { toggleMode } from 'mode-watcher';
	import { Button } from '../button/index.js';

	type LightSwitchProps = {
		variant?: 'ghost' | 'outline';
	};

	let { variant = 'outline' }: LightSwitchProps = $props();
</script>

<Button onclick={toggleMode} {variant} size="icon" tooltip="Toggle theme">
	<SunIcon
		class="scale-100 rotate-0 !transition-all dark:scale-0 dark:-rotate-90"
	/>
	<MoonIcon
		class="absolute scale-0 rotate-90 !transition-all dark:scale-100 dark:rotate-0"
	/>
	<span class="sr-only">Toggle theme</span>
</Button>
