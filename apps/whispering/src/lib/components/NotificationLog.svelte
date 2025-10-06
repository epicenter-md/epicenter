<script module lang="ts">
	const notificationLog = (() => {
		let isOpen = $state(false);
		let logs = $state<UnifiedNotificationOptions[]>([]);
		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value: boolean) {
				isOpen = value;
			},
			get logs() {
				return logs;
			},
			addLog: (log: UnifiedNotificationOptions) => {
				logs.push(log);
			},
			clearLogs: () => {
				logs = [];
			},
		};
	})();

	export { notificationLog };
</script>

<script lang="ts">
	import * as Alert from '@repo/ui/alert';
	import * as Popover from '@repo/ui/popover';
	import type { UnifiedNotificationOptions } from '$lib/services/notifications/types';
	import { ScrollArea } from '@repo/ui/scroll-area';
	import {
		AlertCircle,
		AlertTriangle,
		CheckCircle2,
		Info,
		Loader,
		LogsIcon,
	} from '@lucide/svelte';
	import { mode } from 'mode-watcher';
	import WhisperingButton from './WhisperingButton.svelte';
	import { cn } from '@repo/ui/utils';
</script>

<Popover.Root bind:open={notificationLog.isOpen}>
	<Popover.Trigger>
		{#snippet child({ props })}
			{@const { class: propsClass, ...restProps } = props}
			<WhisperingButton
				tooltipContent="Notification History"
				class={cn(
					'fixed bottom-4 right-4 z-50 hidden xs:inline-flex',
					propsClass,
				)}
				variant="outline"
				size="icon"
				{...restProps}
			>
				<LogsIcon class="size-4" />
			</WhisperingButton>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		class={cn(
			'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-[90vw] max-w-md p-4',
		)}
	>
		<div class="flex flex-col space-y-1.5">
			<h1 class="text-lg font-semibold">Notification History</h1>
			<h2 class="text-sm text-muted-foreground">View past notifications</h2>
		</div>

		<ScrollArea
			class="mt-4 h-[60vh] overflow-y-auto rounded-md border bg-background p-4"
			data-sonner-toaster
			data-theme={mode.current}
			data-rich-colors="true"
		>
			{#each notificationLog.logs as log}
				<Alert.Root
					class="mb-2 last:mb-0"
					data-sonner-toast
					data-type={log.variant}
					data-styled="true"
					data-mounted="true"
				>
					<div class="flex items-center gap-3">
						{#if log.variant === 'error'}
							<div data-icon class="text-destructive">
								<AlertCircle class="size-4" />
							</div>
						{:else if log.variant === 'warning'}
							<div data-icon class="text-warning">
								<AlertTriangle class="size-4" />
							</div>
						{:else if log.variant === 'success'}
							<div data-icon class="text-success">
								<CheckCircle2 class="size-4" />
							</div>
						{:else if log.variant === 'info'}
							<div data-icon class="text-info"><Info class="size-4" /></div>
						{:else if log.variant === 'loading'}
							<div data-icon class="text-muted-foreground">
								<Loader class="size-4 animate-spin" />
							</div>
						{/if}
						<div class="flex-1">
							<Alert.Title
								class="text-sm font-medium leading-none tracking-tight"
							>
								{log.title}
							</Alert.Title>
							<Alert.Description class="mt-1 text-sm text-muted-foreground">
								{log.description}
							</Alert.Description>
						</div>
					</div>
				</Alert.Root>
			{/each}

			{#if notificationLog.logs.length === 0}
				<div
					class="flex h-32 items-center justify-center text-sm text-muted-foreground"
				>
					No logs to display
				</div>
			{/if}
		</ScrollArea>
	</Popover.Content>
</Popover.Root>

<style>
	:global([data-slot='popover-content'] [data-sonner-toast]) {
		position: relative;
	}
</style>
