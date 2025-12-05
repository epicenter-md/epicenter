<script module lang="ts">
	export const moreDetailsDialog = (() => {
		let isOpen = $state(false);
		let title = $state<string>('');
		let description = $state<string>('');
		let content = $state<unknown>(null);
		let buttons = $state<
			{
				label: string;
				onClick: () => void;
				variant?: 'default' | 'destructive';
			}[]
		>([]);

		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value: boolean) {
				isOpen = value;
			},
			get title() {
				return title;
			},
			get description() {
				return description;
			},
			get content() {
				if (typeof content === 'string') {
					return content;
				}
				if (content instanceof Error) {
					return content.message;
				}
				return JSON.stringify(content, null, 2);
			},
			get buttons() {
				return buttons;
			},
			open: (payload: {
				title: string;
				description: string;
				content: unknown;
				buttons?: {
					label: string;
					onClick: () => void;
					variant?: 'default' | 'destructive';
				}[];
			}) => {
				title = payload.title;
				description = payload.description;
				content = payload.content;
				buttons = payload.buttons ?? [];
				isOpen = true;
			},
		};
	})();
</script>

<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import { Button } from '@epicenter/ui/button';
</script>

<Dialog.Root bind:open={moreDetailsDialog.isOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{moreDetailsDialog.title}</Dialog.Title>
			<Dialog.Description>{moreDetailsDialog.description}</Dialog.Description>
		</Dialog.Header>
		<pre
			class="bg-muted relative whitespace-pre-wrap break-words rounded p-4 pr-12 font-mono text-sm overflow-x-auto">{moreDetailsDialog.content}</pre>
		{#if moreDetailsDialog.buttons.length !== 0}
			<Dialog.Footer>
				{#each moreDetailsDialog.buttons as button}
					<Button
						variant={button.variant}
						onclick={() => {
							button.onClick();
							moreDetailsDialog.isOpen = false;
						}}
					>
						{button.label}
					</Button>
				{/each}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
