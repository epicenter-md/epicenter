<script lang="ts">
	import { VERSION } from '../../version';
	import { Button } from '@epicenter/ui/button';
	import { onMount } from 'svelte';

	let downloadUrl = $state('https://github.com/EpicenterHQ/epicenter/releases');
	let downloadText = $state('Download');

	onMount(() => {
		const userAgent = navigator.userAgent.toLowerCase();
		const platform = navigator.platform.toLowerCase();

		if (userAgent.includes('mac') || platform.includes('mac')) {
			downloadUrl = `https://github.com/EpicenterHQ/epicenter/releases/download/v${VERSION}/Whispering_${VERSION}_aarch64.dmg`;
			downloadText = 'Download for Apple Silicon Mac';
		} else if (userAgent.includes('win')) {
			downloadUrl = `https://github.com/EpicenterHQ/epicenter/releases/download/v${VERSION}/Whispering_${VERSION}_x64_en-US.msi`;
			downloadText = 'Download Whispering for Windows';
		} else if (userAgent.includes('linux')) {
			downloadUrl = 'https://github.com/EpicenterHQ/epicenter/releases';
			downloadText = 'Download Whispering for Linux';
		} else {
			downloadUrl = 'https://github.com/EpicenterHQ/epicenter/releases';
			downloadText = 'Download Whispering';
		}
	});
</script>

<Button
	href={downloadUrl}
	size="lg"
	class="w-full sm:w-auto min-w-[200px] min-h-[48px] shadow-lg hover:shadow-xl transition-all group font-semibold"
>
	<svg
		class="w-5 h-5 mr-2 group-hover:translate-y-0.5 transition-transform"
		fill="none"
		stroke="currentColor"
		viewBox="0 0 24 24"
	>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="2"
			d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
		/>
	</svg>
	{downloadText}
</Button>
