<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { auth } from '#platform/auth';

	$effect(() => {
		void goto(auth.state.status === 'signed-out' ? '/device' : '/account', {
			replaceState: true,
		});
	});
</script>

<Loading class="h-dvh" label="Opening Honeycrisp…" />
