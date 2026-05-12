<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Switch } from '@epicenter/ui/switch';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { rpc } from '$lib/query';
	import { deviceConfig, type DeviceConfigKey } from '$lib/state/device-config.svelte';

	/** All device config keys that get exported to USB (excludes hardware IDs and global shortcuts). */
	const SYNC_KEYS: DeviceConfigKey[] = [
		'apiKeys.openai',
		'apiKeys.anthropic',
		'apiKeys.groq',
		'apiKeys.google',
		'apiKeys.deepgram',
		'apiKeys.elevenlabs',
		'apiKeys.mistral',
		'apiKeys.openrouter',
		'apiKeys.custom',
		'apiEndpoints.openai',
		'apiEndpoints.groq',
		'transcription.speaches.baseUrl',
		'transcription.speaches.modelId',
		'transcription.whispercpp.modelPath',
		'transcription.parakeet.modelPath',
		'transcription.moonshine.modelPath',
		'completion.custom.baseUrl',
	];

	const SYNC_FILENAME = 'whispering-config.json';

	let syncFolder = $state('');
	let includeApiKeys = $state(true);
	let isExporting = $state(false);
	let isImporting = $state(false);

	async function pickFolder() {
		if (!window.__TAURI_INTERNALS__) {
			rpc.notify.error({
				title: 'Desktop only',
				description: 'USB sync requires the desktop app.',
			});
			return;
		}
		const { open } = await import('@tauri-apps/plugin-dialog');
		const selected = await open({ directory: true, multiple: false });
		if (typeof selected === 'string') syncFolder = selected;
	}

	function buildExportPayload(): Record<string, string> {
		const keysToExport = includeApiKeys
			? SYNC_KEYS
			: SYNC_KEYS.filter((k) => !k.startsWith('apiKeys.'));

		return Object.fromEntries(
			keysToExport.map((k) => [k, String(deviceConfig.get(k) ?? '')]),
		);
	}

	async function exportConfig() {
		if (!syncFolder) {
			rpc.notify.error({ title: 'No folder selected', description: 'Pick a folder first.' });
			return;
		}
		isExporting = true;
		try {
			const { writeTextFile, join } = await Promise.all([
				import('@tauri-apps/plugin-fs'),
				import('@tauri-apps/api/path'),
			]).then(([fs, path]) => ({ writeTextFile: fs.writeTextFile, join: path.join }));

			const filePath = await join(syncFolder, SYNC_FILENAME);
			const payload = buildExportPayload();
			await writeTextFile(filePath, JSON.stringify(payload, null, 2));
			rpc.notify.success({
				title: 'Config exported',
				description: `Saved ${Object.keys(payload).length} settings to ${SYNC_FILENAME}`,
			});
		} catch (e) {
			rpc.notify.error({
				title: 'Export failed',
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			isExporting = false;
		}
	}

	async function importConfig() {
		if (!syncFolder) {
			rpc.notify.error({ title: 'No folder selected', description: 'Pick a folder first.' });
			return;
		}
		isImporting = true;
		try {
			const { readTextFile, join } = await Promise.all([
				import('@tauri-apps/plugin-fs'),
				import('@tauri-apps/api/path'),
			]).then(([fs, path]) => ({ readTextFile: fs.readTextFile, join: path.join }));

			const filePath = await join(syncFolder, SYNC_FILENAME);
			const raw = await readTextFile(filePath);
			const parsed = JSON.parse(raw) as Record<string, string>;

			let count = 0;
			for (const key of SYNC_KEYS) {
				if (key in parsed && typeof parsed[key] === 'string') {
					deviceConfig.set(key as DeviceConfigKey, parsed[key] as never);
					count++;
				}
			}
			rpc.notify.success({
				title: 'Config imported',
				description: `Applied ${count} settings from ${SYNC_FILENAME}`,
			});
		} catch (e) {
			rpc.notify.error({
				title: 'Import failed',
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			isImporting = false;
		}
	}
</script>

<div class="space-y-6">
	<SectionHeader.Root>
		<SectionHeader.Icon>
			<HardDriveIcon class="size-4" />
		</SectionHeader.Icon>
		<SectionHeader.Title>USB Sync</SectionHeader.Title>
		<SectionHeader.Description>
			Export or import your configuration—API keys, model paths, and
			endpoints—to any folder including a USB drive.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title class="text-sm font-medium">Sync folder</Card.Title>
			<Card.Description class="text-xs">
				Point this at a USB drive or any shared folder.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			<div class="flex gap-2">
				<Input
					class="font-mono text-xs"
					placeholder="/Volumes/USB Drive"
					bind:value={syncFolder}
					readonly
				/>
				<Button variant="outline" size="icon" tooltip="Browse…" onclick={pickFolder}>
					<FolderOpenIcon class="size-4" />
				</Button>
			</div>

			<Field.Root class="flex flex-row items-center justify-between gap-4">
				<div>
					<Field.Label>Include API keys</Field.Label>
					<Field.Description>
						API keys are stored in plain text in the JSON file.
					</Field.Description>
				</div>
				<Switch bind:checked={includeApiKeys} />
			</Field.Root>
		</Card.Content>
		<Card.Footer class="flex gap-2">
			<Button
				variant="outline"
				disabled={!syncFolder || isExporting}
				onclick={exportConfig}
				class="flex-1"
			>
				<UploadIcon class="mr-1.5 size-4" />
				{isExporting ? 'Exporting…' : 'Export to folder'}
			</Button>
			<Button
				disabled={!syncFolder || isImporting}
				onclick={importConfig}
				class="flex-1"
			>
				<DownloadIcon class="mr-1.5 size-4" />
				{isImporting ? 'Importing…' : 'Import from folder'}
			</Button>
		</Card.Footer>
	</Card.Root>

	<Card.Root class="border-warning/30">
		<Card.Content class="pt-4">
			<p class="text-muted-foreground text-xs">
				<strong>Security note:</strong> The exported file is plain JSON—no
				encryption. Don't leave a USB drive with API keys unattended.
			</p>
		</Card.Content>
	</Card.Root>
</div>
