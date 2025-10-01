<script lang="ts">
	import { LabeledSwitch } from '$lib/components/labeled';
	import { Separator } from '@repo/ui/separator';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<svelte:head>
	<title>Sound Settings - Whispering</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">Sound</h3>
		<p class="text-muted-foreground text-sm">
			Configure your Whispering sound preferences.
		</p>
	</div>

	<Separator />

	<LabeledSwitch
		id="sound.playOn.manual-start"
		label="Play sound when starting manual recording"
		bind:checked={
			() => settings.value['sound.playOn.manual-start'],
			(v) => settings.updateKey('sound.playOn.manual-start', v)
		}
	/>

	<LabeledSwitch
		id="sound.playOn.manual-start"
		label="Play sound when stopping manual recording"
		bind:checked={
			() => settings.value['sound.playOn.manual-stop'],
			(v) => settings.updateKey('sound.playOn.manual-stop', v)
		}
	/>

	<LabeledSwitch
		id="sound.playOn.manual-start"
		label="Play sound when canceling manual recording"
		bind:checked={
			() => settings.value['sound.playOn.manual-cancel'],
			(v) => settings.updateKey('sound.playOn.manual-cancel', v)
		}
	/>

	<Separator />

	<LabeledSwitch
		id="sound.playOn.vad-start"
		label="Play sound when starting vad recording session"
		bind:checked={
			() => settings.value['sound.playOn.vad-start'],
			(v) => settings.updateKey('sound.playOn.vad-start', v)
		}
	/>

	<LabeledSwitch
		id="sound.playOn.vad-start"
		label="Play sound vad capture"
		bind:checked={
			() => settings.value['sound.playOn.vad-capture'],
			(v) => settings.updateKey('sound.playOn.vad-capture', v)
		}
	/>

	<LabeledSwitch
		id="sound.playOn.vad-start"
		label="Play sound when stopping vad recording session"
		bind:checked={
			() => settings.value['sound.playOn.vad-stop'],
			(v) => settings.updateKey('sound.playOn.vad-stop', v)
		}
	/>

	<Separator />

	<LabeledSwitch
		id="play-sound-transcription"
		label="Play sound after transcription"
		bind:checked={
			() => settings.value['sound.playOn.transcriptionComplete'],
			(v) => settings.updateKey('sound.playOn.transcriptionComplete', v)
		}
	/>

	<LabeledSwitch
		id="play-sound-transformation"
		label="Play sound after transformation"
		bind:checked={
			() => settings.value['sound.playOn.transformationComplete'],
			(v) => settings.updateKey('sound.playOn.transformationComplete', v)
		}
	/>
</div>
