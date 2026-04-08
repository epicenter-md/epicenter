<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { AuthClient } from '../auth/create-auth.svelte.js';

	let {
		auth,
		syncNoun,
		onSocialSignIn,
	}: {
		/** The auth client instance from `createAuth()`. */
		auth: AuthClient;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/**
		 * Social sign-in handler called when the user clicks "Continue with Google".
		 * Return shape must include an `error` property with a `message` string,
		 * or `null` on success—matches the `Result` type returned by all auth methods.
		 */
		onSocialSignIn: () => Promise<{ error: { message: string } | null }>;
	} = $props();

	let email = $state('');
	let password = $state('');
	let name = $state('');
	let mode = $state<'sign-in' | 'sign-up'>('sign-in');
	let submitError = $state<string | null>(null);

	const isSignUp = $derived(mode === 'sign-up');
</script>

<form
	onsubmit={async (e) => {
		e.preventDefault();
		submitError = null;
		const { error } = isSignUp
			? await auth.signUp({ email, password, name })
			: await auth.signIn({ email, password });
		if (error) submitError = error.message;
	}}
	class="w-full max-w-xs"
>
	<Field.Set>
		<Field.Legend>{isSignUp ? 'Create account' : 'Sign in'}</Field.Legend>
		<Field.Description>
			{isSignUp
				? `Create an account to sync your ${syncNoun} across devices.`
				: `Sign in to sync your ${syncNoun} across devices.`}
		</Field.Description>

		{#if submitError}
			<Field.Error>{submitError}</Field.Error>
		{/if}

		<Button
			type="button"
			variant="outline"
			class="w-full"
			disabled={auth.isBusy}
			onclick={async () => {
				submitError = null;
				const { error } = await onSocialSignIn();
				if (error) submitError = error.message;
			}}
		>
			<svg class="size-4" viewBox="0 0 24 24" aria-hidden="true">
				<path
					d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
					fill="#4285F4"
				/>
				<path
					d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
					fill="#34A853"
				/>
				<path
					d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
					fill="#FBBC05"
				/>
				<path
					d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
					fill="#EA4335"
				/>
			</svg>
			Continue with Google
		</Button>

		<Field.Separator>or</Field.Separator>

		<Field.Group>
			{#if isSignUp}
				<Field.Field>
					<Field.Label for="name">Name</Field.Label>
					<Input
						id="name"
						type="text"
						placeholder="Name"
						bind:value={name}
						required
						autocomplete="name"
					/>
				</Field.Field>
			{/if}
			<Field.Field>
				<Field.Label for="email">Email</Field.Label>
				<Input
					id="email"
					type="email"
					placeholder="Email"
					bind:value={email}
					required
					autocomplete="email"
				/>
			</Field.Field>
			<Field.Field>
				<Field.Label for="password">Password</Field.Label>
				<Input
					id="password"
					type="password"
					placeholder="Password"
					bind:value={password}
					required
					autocomplete={isSignUp ? 'new-password' : 'current-password'}
				/>
			</Field.Field>
		</Field.Group>

		<Button type="submit" class="w-full" disabled={auth.isBusy}>
			{#if auth.isBusy}
				<Spinner class="size-4" />
				{isSignUp ? 'Creating account…' : 'Signing in…'}
			{:else}
				{isSignUp ? 'Create account' : 'Sign in'}
			{/if}
		</Button>

		<p class="text-center text-sm text-muted-foreground">
			{#if isSignUp}
				Already have an account?
				<button
					type="button"
					class="text-foreground underline underline-offset-4 hover:text-foreground/80"
					onclick={() => {
						mode = 'sign-in';
						submitError = null;
					}}
				>
					Sign in
				</button>
			{:else}
				Don't have an account?
				<button
					type="button"
					class="text-foreground underline underline-offset-4 hover:text-foreground/80"
					onclick={() => {
						mode = 'sign-up';
						submitError = null;
					}}
				>
					Sign up
				</button>
			{/if}
		</p>
	</Field.Set>
</form>
