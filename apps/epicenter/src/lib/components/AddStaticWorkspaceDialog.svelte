<script lang="ts" module>
	type AddStaticWorkspaceDialogOptions = {
		onConfirm: (data: { id: string; name?: string }) => Promise<void>;
	};

	function createAddStaticWorkspaceDialogState() {
		let isOpen = $state(false);
		let isPending = $state(false);
		let id = $state('');
		let name = $state('');
		let error = $state<string | null>(null);
		let options = $state<AddStaticWorkspaceDialogOptions | null>(null);

		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value) {
				isOpen = value;
			},
			get isPending() {
				return isPending;
			},
			get id() {
				return id;
			},
			set id(value) {
				id = value;
				error = null;
			},
			get name() {
				return name;
			},
			set name(value) {
				name = value;
			},
			get error() {
				return error;
			},
			get options() {
				return options;
			},
			get canConfirm() {
				return id.trim().length > 0 && !isPending;
			},

			open(opts: AddStaticWorkspaceDialogOptions) {
				options = opts;
				isPending = false;
				id = '';
				name = '';
				error = null;
				isOpen = true;
			},

			close() {
				isOpen = false;
				isPending = false;
				id = '';
				name = '';
				error = null;
				options = null;
			},

			async confirm() {
				if (!options || !id.trim()) return;

				error = null;
				isPending = true;
				try {
					await options.onConfirm({
						id: id.trim(),
						name: name.trim() || undefined,
					});
					isOpen = false;
					id = '';
					name = '';
				} catch (e) {
					error =
						e instanceof Error
							? e.message
							: typeof e === 'object' && e !== null && 'message' in e
								? String((e as { message: unknown }).message)
								: 'Failed to add workspace';
				} finally {
					isPending = false;
				}
			},

			cancel() {
				isOpen = false;
				id = '';
				name = '';
				error = null;
				isPending = false;
			},
		};
	}

	export const addStaticWorkspaceDialog = createAddStaticWorkspaceDialogState();
</script>

<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Button } from '@epicenter/ui/button';
</script>

<Dialog.Root bind:open={addStaticWorkspaceDialog.isOpen}>
	<Dialog.Content class="sm:max-w-md">
		<form
			method="POST"
			onsubmit={(e) => {
				e.preventDefault();
				addStaticWorkspaceDialog.confirm();
			}}
			class="flex flex-col gap-4"
		>
			<Dialog.Header>
				<Dialog.Title>Add Static Workspace</Dialog.Title>
				<Dialog.Description>
					Enter the ID of a static workspace to view its synced data.
				</Dialog.Description>
			</Dialog.Header>

			<Field.Group>
				<Field.Field data-invalid={!!addStaticWorkspaceDialog.error}>
					<Field.Label for="static-workspace-id">Workspace ID</Field.Label>
					<Input
						id="static-workspace-id"
						bind:value={addStaticWorkspaceDialog.id}
						placeholder="e.g., tab-manager"
						disabled={addStaticWorkspaceDialog.isPending}
						class="font-mono text-sm"
						aria-invalid={!!addStaticWorkspaceDialog.error}
					/>
					{#if addStaticWorkspaceDialog.error}
						<Field.Error>{addStaticWorkspaceDialog.error}</Field.Error>
					{:else}
						<Field.Description>
							The unique identifier used by the workspace
						</Field.Description>
					{/if}
				</Field.Field>

				<Field.Field>
					<Field.Label for="static-workspace-name"
						>Display Name (optional)</Field.Label
					>
					<Input
						id="static-workspace-name"
						bind:value={addStaticWorkspaceDialog.name}
						placeholder="e.g., Tab Manager"
						disabled={addStaticWorkspaceDialog.isPending}
					/>
				</Field.Field>
			</Field.Group>

			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={() => addStaticWorkspaceDialog.cancel()}
					disabled={addStaticWorkspaceDialog.isPending}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={!addStaticWorkspaceDialog.canConfirm}>
					{addStaticWorkspaceDialog.isPending ? 'Adding...' : 'Add Workspace'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
