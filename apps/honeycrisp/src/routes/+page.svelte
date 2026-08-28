<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { auth } from '#platform/auth';

	// Resolved rather than written literally. The Epicenter build serves this
	// SPA below `/apps/honeycrisp`, and a bare `/device` is outside that base,
	// so the client router treats it as somewhere else entirely and hands it
	// to the browser, which asks the host for a page it does not serve.
	$effect(() => {
		void goto(
			auth.state.status === 'signed-out'
				? resolve('/device')
				: resolve('/account'),
			{ replaceState: true },
		);
	});
</script>

<Loading class="h-dvh" label="Opening Honeycrisp…" />
