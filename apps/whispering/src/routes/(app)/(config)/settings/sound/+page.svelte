<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { SettingSwitch } from '$lib/components/settings';
</script>

<svelte:head> <title>Sound Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Sound</Field.Legend>
	<Field.Description>
		Configure your Whispering sound preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Manual Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for manual recording events.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="settings.sound.manualStart"
					label="Play sound when starting manual recording"
				/>
				<SettingSwitch
					key="settings.sound.manualStop"
					label="Play sound when stopping manual recording"
				/>
				<SettingSwitch
					key="settings.sound.manualCancel"
					label="Play sound when canceling manual recording"
				/>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">VAD Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for voice-activated detection events.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="settings.sound.vadStart"
					label="Play sound when starting VAD recording session"
				/>
				<SettingSwitch
					key="settings.sound.vadCapture"
					label="Play sound on VAD capture"
				/>
				<SettingSwitch
					key="settings.sound.vadStop"
					label="Play sound when stopping VAD recording session"
				/>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Completion Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for transcription and recipe completion.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="settings.sound.transcriptionComplete"
					label="Play sound after transcription"
				/>
				<SettingSwitch
					key="settings.sound.recipeComplete"
					label="Play sound after a recipe runs"
				/>
			</Field.Group>
		</Field.Set>
	</Field.Group>
</Field.Set>
