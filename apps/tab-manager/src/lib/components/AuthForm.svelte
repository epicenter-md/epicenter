<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import { authState } from '$lib/state/auth.svelte';
	import { workspaceClient } from '$lib/workspace';

	const isSignUp = $derived(authState.mode === 'sign-up');
	const isBusy = $derived(authState.status === 'signing-in');
</script>

<form
	onsubmit={async (e) => {
		e.preventDefault();
		const { error } = isSignUp
			? await authState.signUp()
			: await authState.signIn();
		if (!error) workspaceClient.extensions.sync.reconnect();
	}}
	class="w-full max-w-xs"
>
	<Field.Set>
		<Field.Legend>{isSignUp ? 'Create account' : 'Sign in'}</Field.Legend>
		<Field.Description>
			{isSignUp
				? 'Create an account to sync your tabs across devices.'
				: 'Sign in to sync your tabs across devices.'}
		</Field.Description>

		{#if authState.signInError}
			<Alert.Root variant="destructive">
				<Alert.Description>{authState.signInError}</Alert.Description>
			</Alert.Root>
		{/if}

		<Button
			type="button"
			variant="outline"
			class="w-full"
			disabled={isBusy}
			onclick={async () => {
				const { error } = await authState.signInWithGoogle();
				if (!error) workspaceClient.extensions.sync.reconnect();
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
						bind:value={authState.name}
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
					bind:value={authState.email}
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
					bind:value={authState.password}
					required
					autocomplete={isSignUp ? 'new-password' : 'current-password'}
				/>
			</Field.Field>
		</Field.Group>

		<Button type="submit" class="w-full" disabled={isBusy}>
			{#if isBusy}
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
					onclick={() => (authState.mode = 'sign-in')}
				>
					Sign in
				</button>
			{:else}
				Don't have an account?
				<button
					type="button"
					class="text-foreground underline underline-offset-4 hover:text-foreground/80"
					onclick={() => (authState.mode = 'sign-up')}
				>
					Sign up
				</button>
			{/if}
		</p>
	</Field.Set>
</form>
