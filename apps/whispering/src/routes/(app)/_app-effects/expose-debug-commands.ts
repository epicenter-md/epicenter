import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { commandRunners } from '$lib/commands';

/**
 * Expose the command runners and router on `window` for DevTools poking while
 * the app surface is mounted, then restore whatever the host exposed before it.
 */
export function exposeDebugCommands(): void {
	onMount(() => {
		const previousCommands = window.commands;
		const previousGoto = window.goto;
		window.commands = commandRunners;
		window.goto = goto;

		return () => {
			window.commands = previousCommands;
			window.goto = previousGoto;
		};
	});
}
