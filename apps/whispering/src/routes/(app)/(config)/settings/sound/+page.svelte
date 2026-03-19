<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Switch } from '@epicenter/ui/switch';
	import { audioElements } from '$lib/services/sound/assets';
	import { workspaceSettings } from '$lib/state/workspace-settings.svelte';

	function previewVolume(volume: number) {
		const sound = new Audio(audioElements['manual-start'].src);
		sound.volume = volume / 100;
		sound.play();
	}
</script>

<svelte:head> <title>Sound Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Sound</Field.Legend>
	<Field.Description>
		Configure your Whispering sound preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Field>
			<Field.Label for="sound.volume">Volume</Field.Label>
			<Field.Description>
				Adjust the volume for all sound effects ({workspaceSettings.get('sound.volume')}%).
			</Field.Description>
			<input
				id="sound.volume"
				type="range"
				min="0"
				max="100"
				step="1"
				value={workspaceSettings.get('sound.volume')}
				oninput={(e) =>
					workspaceSettings.set(
						'sound.volume',
						Number(e.currentTarget.value),
					)}
			onchange={(e) => previewVolume(Number(e.currentTarget.value))}
				class="w-full accent-primary"
			/>
		</Field.Field>

		<Field.Separator />
		<Field.Set>
			<Field.Legend variant="label">Manual Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for manual recording events.
			</Field.Description>
			<Field.Group>
				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.manual-start"
						bind:checked={() => workspaceSettings.get('sound.manualStart'),
							(v) => workspaceSettings.set('sound.manualStart', v)}
					/>
					<Field.Label for="sound.playOn.manual-start">
						Play sound when starting manual recording
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.manual-stop"
						bind:checked={() => workspaceSettings.get('sound.manualStop'),
							(v) => workspaceSettings.set('sound.manualStop', v)}
					/>
					<Field.Label for="sound.playOn.manual-stop">
						Play sound when stopping manual recording
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.manual-cancel"
						bind:checked={() => workspaceSettings.get('sound.manualCancel'),
							(v) => workspaceSettings.set('sound.manualCancel', v)}
					/>
					<Field.Label for="sound.playOn.manual-cancel">
						Play sound when canceling manual recording
					</Field.Label>
				</Field.Field>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">VAD Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for voice-activated detection events.
			</Field.Description>
			<Field.Group>
				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.vad-start"
						bind:checked={() => workspaceSettings.get('sound.vadStart'),
							(v) => workspaceSettings.set('sound.vadStart', v)}
					/>
					<Field.Label for="sound.playOn.vad-start">
						Play sound when starting VAD recording session
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.vad-capture"
						bind:checked={() => workspaceSettings.get('sound.vadCapture'),
							(v) => workspaceSettings.set('sound.vadCapture', v)}
					/>
					<Field.Label for="sound.playOn.vad-capture">
						Play sound on VAD capture
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.vad-stop"
						bind:checked={() => workspaceSettings.get('sound.vadStop'),
							(v) => workspaceSettings.set('sound.vadStop', v)}
					/>
					<Field.Label for="sound.playOn.vad-stop">
						Play sound when stopping VAD recording session
					</Field.Label>
				</Field.Field>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Completion Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for transcription and transformation completion.
			</Field.Description>
			<Field.Group>
				<Field.Field orientation="horizontal">
					<Switch
						id="play-sound-transcription"
						bind:checked={() => workspaceSettings.get('sound.transcriptionComplete'),
							(v) => workspaceSettings.set('sound.transcriptionComplete', v)}
					/>
					<Field.Label for="play-sound-transcription">
						Play sound after transcription
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="play-sound-transformation"
						bind:checked={() => workspaceSettings.get('sound.transformationComplete'),
							(v) => workspaceSettings.set('sound.transformationComplete', v)}
					/>
					<Field.Label for="play-sound-transformation">
						Play sound after transformation
					</Field.Label>
				</Field.Field>
			</Field.Group>
		</Field.Set>
	</Field.Group>
</Field.Set>
