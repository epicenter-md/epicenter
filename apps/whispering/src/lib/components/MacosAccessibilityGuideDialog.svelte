<script module lang="ts">
	import { toast } from '@epicenter/ui/sonner';
	import { tauri } from '#platform/tauri';

	/**
	 * Global opener for the macOS Accessibility guide. Mirrors the
	 * `confirmationDialog` idiom: mount `<MacosAccessibilityGuideDialog />` once at
	 * the app root, then call `accessibilityGuide.open()` from anywhere (the home
	 * notice) to surface the remove/re-add walkthrough. The guide content is fixed,
	 * so the store carries no payload: it
	 * is open or closed and nothing else.
	 *
	 * The guide is user-opened, never auto-popped: the ambient "you still need
	 * this" signal is the declarative `DictationCapabilityNotice`, which a modal
	 * must not duplicate by nagging.
	 */
	function createAccessibilityGuide() {
		let isOpen = $state(false);
		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value) {
				isOpen = value;
			},
			open() {
				isOpen = true;
			},
			close() {
				isOpen = false;
			},
		};
	}

	export const accessibilityGuide = createAccessibilityGuide();

	/**
	 * Shared "send me to the Accessibility pane" action for both macOS
	 * accessibility surfaces: the home notice and this guide. It lives here beside
	 * `accessibilityGuide` because those are its only two callers and the toast
	 * copy must stay identical between them.
	 *
	 * macOS never lets an app grant itself Accessibility, so this is the whole
	 * "enable" path. The leading `request()` fires only for its first-run side
	 * effect: it adds Epicenter to the Accessibility list (toggle off) so the
	 * user flips a switch instead of hunting with "+", and shows the native prompt
	 * once (TCC suppresses it after). We discard its Result: it cannot grant in
	 * place and a failed prompt must not block the deep-link. The capability then
	 * flips to `active` on its own when the Rust supervisor next sees the grant.
	 */
	export async function openSystemSettings() {
		if (!tauri) return;
		await tauri.permissions.accessibility.request();
		const { error } = await tauri.permissions.accessibility.openSettings();
		if (error) {
			toast.info('Open System Settings manually', {
				description:
					'Apple menu → System Settings → Privacy & Security → Accessibility',
				duration: 10000,
			});
			return;
		}
		toast.info('System Settings opened', {
			description: 'Turn on Epicenter in Privacy & Security > Accessibility.',
			duration: 8000,
		});
	}
</script>

<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import MacosAccessibilityGuide from '$lib/components/MacosAccessibilityGuide.svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';

	// The Rust supervisor pushes the capability change, so the dialog flips to its
	// granted state the moment the supervisor sees the grant, with no reload.
	const isGranted = $derived(dictationCapability.isActive);

	// A stale grant (`broken`) is the only case that needs the remove-and-re-add
	// dance; never-granted (and the pre-seed `unknown`) just needs the switch
	// flipped on a row `openSystemSettings` already added. This drives the title,
	// the description, and which steps the guide renders, so a first-timer is never
	// told to remove an Epicenter that isn't in their list yet.
	const variant = $derived(
		dictationCapability.isStale ? 're-add' : 'first-grant',
	);
</script>

<Dialog.Root bind:open={accessibilityGuide.isOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>
				{variant === 're-add' ? 'Re-grant Accessibility' : 'Enable Accessibility'}
			</Dialog.Title>
			<Dialog.Description>
				{#if variant === 're-add'}
					Epicenter already has Accessibility, but paste at cursor is not
					working. That usually means a stale entry from an app update. Open
					System Settings below, then remove Epicenter from the list and add it
					back.
				{:else}
					macOS needs Accessibility before Epicenter can paste where you're
					typing. Open System Settings below, then switch Epicenter on. It'll
					already be in the list.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<MacosAccessibilityGuide {variant} />

		<Dialog.Footer>
			{#if isGranted}
				<Badge variant="success">
					<CheckIcon class="size-4" aria-hidden="true" />
					Accessibility granted
				</Badge>
				<Button variant="outline" onclick={() => accessibilityGuide.close()}>
					Done
				</Button>
			{:else}
				<Button onclick={openSystemSettings}>
					<SettingsIcon class="size-4" aria-hidden="true" />
					Open System Settings
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
