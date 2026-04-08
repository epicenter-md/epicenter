<script lang="ts">
	import { fromKv } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { chatState } from '$lib/chat/chat-state.svelte';
	import { auth, workspace } from '$lib/client';
	import ChatInput from '$lib/components/ChatInput.svelte';
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import ModelPicker from '$lib/components/ModelPicker.svelte';
	import ZhongwenSidebar from '$lib/components/ZhongwenSidebar.svelte';

	const showPinyin = fromKv(workspace.kv, 'showPinyin');
	let dismissedError = $state(false);
	let submitError = $state<string | null>(null);

	const handle = $derived(chatState.active);

	async function signInWithGoogle() {
		const { error } = await auth.signInWithSocialRedirect({
			provider: 'google',
			callbackURL: window.location.origin,
		});
		if (error) submitError = error.message;
	}
</script>

<Sidebar.Provider>
	<ZhongwenSidebar />

	<main class="flex h-dvh flex-1 flex-col">
		<!-- Header -->
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">中文 Zhongwen</h1>
				{#if handle}
					<ModelPicker {handle} />
				{/if}
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant={showPinyin.current ? 'default' : 'outline'}
					size="sm"
					onclick={() => (showPinyin.current = !showPinyin.current)}
					aria-pressed={showPinyin.current}
					aria-label="Toggle pinyin annotations"
				>
					{showPinyin.current ? 'Hide Pinyin' : 'Show Pinyin'}
				</Button>

				{#if auth.isAuthenticated}
					<span class="text-sm text-muted-foreground">{auth.user?.name}</span>
				{:else if !auth.isAuthenticated}
					<Button size="sm" onclick={signInWithGoogle}> Sign In </Button>
				{/if}
			</div>
		</header>

		<!-- Messages -->
		{#if auth.isBusy}
			<div class="flex flex-1 items-center justify-center">
				<p class="text-muted-foreground">Signing in…</p>
			</div>
		{:else if !auth.isAuthenticated}
			<div class="flex flex-1 items-center justify-center">
				<div class="text-center text-muted-foreground">
					<p class="mb-4">Sign in to start chatting</p>
					{#if submitError}
						<p class="text-sm text-destructive">{submitError}</p>
					{/if}
					<Button onclick={signInWithGoogle}>Sign in with Google</Button>
				</div>
			</div>
		{:else if handle}
			<Chat.List class="flex-1 overflow-y-auto p-4" aria-live="polite">
				{#if handle.messages.length === 0}
					<div
						class="flex flex-1 items-center justify-center text-muted-foreground"
					>
						<p>
							Ask a question in English and get a response in Chinese and
							English.
						</p>
					</div>
				{:else}
					{#each handle.messages as message, i (message.id)}
						<ChatMessage
							{message}
							showPinyin={showPinyin.current}
							isStreaming={handle.isLoading}
							isLast={i === handle.messages.length - 1}
							onRegenerate={() => handle.reload()}
						/>
					{/each}
				{/if}

				{#if handle.isLoading}
					<Chat.Bubble variant="received">
						<Chat.BubbleMessage typing />
					</Chat.Bubble>
				{/if}

				{#if handle.error && !dismissedError}
					<div
						class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
					>
						<span class="flex-1">{handle.error.message}</span>
						<Button size="sm" variant="outline" onclick={() => handle.reload()}
							>Retry</Button
						>
						<Button
							size="sm"
							variant="ghost"
							onclick={() => (dismissedError = true)}
							>✕</Button
						>
					</div>
				{/if}
			</Chat.List>

			<ChatInput {handle} />
		{/if}
	</main>
</Sidebar.Provider>
