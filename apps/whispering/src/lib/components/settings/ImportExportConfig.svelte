<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { settings } from '$lib/state/settings.svelte';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { createMutation } from '@tanstack/svelte-query';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import type { ConfigExport } from '$lib/services/isomorphic/config-export';
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import { Switch } from '@epicenter/ui/switch';

	const exportMutation = createMutation(() => rpc.config.export.options);
	const importMutation = createMutation(() => rpc.config.import.options);

	let includeApiKeys = $state(false);
	let fileInput: HTMLInputElement;

	function handleExport() {
		exportMutation.mutate(
			{
				settings: settings.value,
				options: { includeApiKeys },
			},
			{
				onSuccess: (config: ConfigExport) => {
					// createQueryFactories unwraps Result types automatically
					// config is already the unwrapped data here
					const json = JSON.stringify(config, null, 2);

					const timestamp = new Date()
						.toISOString()
						.replace(/:/g, '-')
						.split('.')[0];
					const filename = `whispering-config-${timestamp}.json`;

					saveConfigFile(filename, json);
				},
				onError: (error: any) => {
					rpc.notify.error({
						title: error.title || 'Failed to export configuration',
						description: error.description || String(error),
					});
				},
			},
		);
	}

	async function saveConfigFile(filename: string, json: string) {
		// Desktop: Use Tauri file dialog
		if (window.__TAURI_INTERNALS__) {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const { writeTextFile } = await import('@tauri-apps/plugin-fs');

			const path = await save({
				defaultPath: filename,
				filters: [
					{
						name: 'JSON Config',
						extensions: ['json'],
					},
				],
			});

			if (!path) return; // User cancelled

			try {
				await writeTextFile(path, json);
				rpc.notify.success({
					title: 'Configuration exported',
					description: `Saved to ${path}`,
				});
			} catch (e) {
				rpc.notify.error({
					title: 'Failed to save file',
					description: String(e),
				});
			}
		} else {
			// Web: Download as file
			const blob = new Blob([json], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);

			rpc.notify.success({
				title: 'Configuration exported',
				description: `Downloaded ${filename}`,
			});
		}
	}

	function handleImportClick() {
		fileInput.click();
	}

	async function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		try {
			const text = await file.text();
			const data = JSON.parse(text);

			// Validate the config
			const validationResult = services.configExport.validateConfig(data);
			if (validationResult.error) {
				rpc.notify.error({
					title: 'Invalid configuration file',
					description: validationResult.error.message,
					action: { type: 'more-details', error: validationResult.error },
				});
				return;
			}

			const config: ConfigExport = validationResult.data;

			// Show confirmation dialog with preview
			confirmationDialog.open({
				title: 'Import Configuration',
				description: `This will replace your current settings and transformations. Are you sure you want to continue?\n\n• ${Object.keys(config.settings).length} settings\n• ${config.transformations.length} transformations\n\nExported: ${new Date(config.exportedAt).toLocaleString()}`,
				confirm: { text: 'Import', variant: 'default' },
				onConfirm: () => {
					importMutation.mutate(
						{
							config,
							options: { mergeStrategy: 'replace' },
						},
						{
							onSuccess: (summary) => {
								// createQueryFactories unwraps Result types automatically
								// summary is already the unwrapped data here

								// Apply the imported settings
								settings.update(config.settings);

								rpc.notify.success({
									title: 'Configuration imported',
									description: `Imported ${summary.settingsUpdated} settings and ${summary.transformationsCreated} transformations`,
								});
							},
							onError: (error: any) => {
								rpc.notify.error({
									title: error.title || 'Failed to import configuration',
									description: error.description || String(error),
								});
							},
						},
					);
				},
			});
		} catch (e) {
			rpc.notify.error({
				title: 'Failed to read file',
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			// Reset file input
			input.value = '';
		}
	}
</script>

<Field.Set>
	<Field.Legend variant="label">Import/Export Configuration</Field.Legend>
	<Field.Description>
		Backup your settings and transformations or transfer them to another device.
	</Field.Description>

	<Field.Group>
		<Field.Field orientation="horizontal">
			<Switch id="include-api-keys" bind:checked={includeApiKeys} />
			<Field.Label for="include-api-keys">
				<Field.Content>
					<Field.Title>Include API Keys</Field.Title>
					<Field.Description>
						⚠️ Warning: API keys will be included in plain text
					</Field.Description>
				</Field.Content>
			</Field.Label>
		</Field.Field>

		<div class="flex gap-2">
			<Button
				onclick={handleExport}
				disabled={exportMutation.isPending}
				variant="outline"
				class="flex-1"
			>
				<DownloadIcon class="size-4" />
				Export Configuration
			</Button>

			<Button
				onclick={handleImportClick}
				disabled={importMutation.isPending}
				variant="outline"
				class="flex-1"
			>
				<UploadIcon class="size-4" />
				Import Configuration
			</Button>
		</div>

		<input
			bind:this={fileInput}
			type="file"
			accept=".json"
			onchange={handleFileSelect}
			class="hidden"
		/>
	</Field.Group>
</Field.Set>
