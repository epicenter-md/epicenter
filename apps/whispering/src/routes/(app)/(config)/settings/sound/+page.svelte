<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Separator } from '@epicenter/ui/separator';
	import { Switch } from '@epicenter/ui/switch';
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

	<Field.Field orientation="horizontal">
		<Switch
			id="sound.playOn.manual-start"
			bind:checked={
				() => settings.value['sound.playOn.manual-start'],
				(v) => settings.updateKey('sound.playOn.manual-start', v)
			}
		/>
		<Field.Label for="sound.playOn.manual-start">
			Play sound when starting manual recording
		</Field.Label>
	</Field.Field>

	<Field.Field orientation="horizontal">
		<Switch
			id="sound.playOn.manual-stop"
			bind:checked={
				() => settings.value['sound.playOn.manual-stop'],
				(v) => settings.updateKey('sound.playOn.manual-stop', v)
			}
		/>
		<Field.Label for="sound.playOn.manual-stop">
			Play sound when stopping manual recording
		</Field.Label>
	</Field.Field>

	<Field.Field orientation="horizontal">
		<Switch
			id="sound.playOn.manual-cancel"
			bind:checked={
				() => settings.value['sound.playOn.manual-cancel'],
				(v) => settings.updateKey('sound.playOn.manual-cancel', v)
			}
		/>
		<Field.Label for="sound.playOn.manual-cancel">
			Play sound when canceling manual recording
		</Field.Label>
	</Field.Field>

	<Separator />

	<Field.Field orientation="horizontal">
		<Switch
			id="sound.playOn.vad-start"
			bind:checked={
				() => settings.value['sound.playOn.vad-start'],
				(v) => settings.updateKey('sound.playOn.vad-start', v)
			}
		/>
		<Field.Label for="sound.playOn.vad-start">
			Play sound when starting vad recording session
		</Field.Label>
	</Field.Field>

	<Field.Field orientation="horizontal">
		<Switch
			id="sound.playOn.vad-capture"
			bind:checked={
				() => settings.value['sound.playOn.vad-capture'],
				(v) => settings.updateKey('sound.playOn.vad-capture', v)
			}
		/>
		<Field.Label for="sound.playOn.vad-capture">
			Play sound vad capture
		</Field.Label>
	</Field.Field>

	<Field.Field orientation="horizontal">
		<Switch
			id="sound.playOn.vad-stop"
			bind:checked={
				() => settings.value['sound.playOn.vad-stop'],
				(v) => settings.updateKey('sound.playOn.vad-stop', v)
			}
		/>
		<Field.Label for="sound.playOn.vad-stop">
			Play sound when stopping vad recording session
		</Field.Label>
	</Field.Field>

	<Separator />

	<Field.Field orientation="horizontal">
		<Switch
			id="play-sound-transcription"
			bind:checked={
				() => settings.value['sound.playOn.transcriptionComplete'],
				(v) => settings.updateKey('sound.playOn.transcriptionComplete', v)
			}
		/>
		<Field.Label for="play-sound-transcription">
			Play sound after transcription
		</Field.Label>
	</Field.Field>

	<Field.Field orientation="horizontal">
		<Switch
			id="play-sound-transformation"
			bind:checked={
				() => settings.value['sound.playOn.transformationComplete'],
				(v) => settings.updateKey('sound.playOn.transformationComplete', v)
			}
		/>
		<Field.Label for="play-sound-transformation">
			Play sound after transformation
		</Field.Label>
	</Field.Field>
</div>
