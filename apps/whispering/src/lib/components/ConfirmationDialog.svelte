<script module lang="ts">
	export const confirmationDialog = createConfirmationDialog();

	function createConfirmationDialog() {
		let isOpen = $state(false);
		let title = $state('');
		let subtitle = $state('');
		let confirmText = $state('');
		let onConfirm = () => {};
		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(v) {
				isOpen = v;
			},
			get title() {
				return title;
			},
			get subtitle() {
				return subtitle;
			},
			get confirmText() {
				return confirmText;
			},
			get onConfirm() {
				return onConfirm;
			},
			open(dialog: {
				title: string;
				subtitle: string;
				confirmText: string;
				onConfirm: () => void;
			}) {
				title = dialog.title;
				subtitle = dialog.subtitle;
				confirmText = dialog.confirmText;
				onConfirm = dialog.onConfirm;
				isOpen = true;
			},
			close() {
				isOpen = false;
			},
		};
	}
</script>

<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
</script>

<AlertDialog.Root bind:open={confirmationDialog.isOpen}>
	<AlertDialog.Content class="sm:max-w-xl">
		<AlertDialog.Header>
			<AlertDialog.Title>{confirmationDialog.title}</AlertDialog.Title>
			<AlertDialog.Description>
				{confirmationDialog.subtitle}
			</AlertDialog.Description>
		</AlertDialog.Header>

		<AlertDialog.Footer>
			<AlertDialog.Cancel
				onclick={() => {
					confirmationDialog.close();
				}}
			>
				Cancel
			</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => {
					confirmationDialog.onConfirm();
					confirmationDialog.close();
				}}
			>
				{confirmationDialog.confirmText}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
