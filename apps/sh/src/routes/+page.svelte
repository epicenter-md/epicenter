<script lang="ts">
	import { PMCommand } from '@repo/ui/pm-command';
	import * as Alert from '@repo/ui/alert';
	import { InfoIcon } from 'lucide-svelte';
	import { Link } from '@repo/ui/link';
</script>

<svelte:head>
	<title>epicenter.sh - Web Interface for Self-Hosted AI Coding</title>
	<meta
		name="description"
		content="Connect to OpenCode servers from your browser. Run fully local or tunnel through ngrok. Your code stays on your machine, even with cloud deployment."
	/>
</svelte:head>

<div
	class="flex flex-col items-center justify-center min-h-[calc(100vh-3.5rem)] px-4 sm:px-6 max-w-2xl mx-auto"
>
	<h1 class="text-5xl font-bold tracking-tight mb-4">
		Welcome to epicenter.sh
	</h1>
	<p class="text-muted-foreground mb-8 text-center">
		Get started by running this command in your terminal:
	</p>

	<div class="w-full mb-8">
		<PMCommand
			command="execute"
			args={['@epicenter/cli@latest', 'sh']}
			agent="bun"
			agents={['bun']}
		/>
	</div>

	<p class="text-sm text-muted-foreground text-center">
		This will start your OpenCode server and open epicenter.sh with your
		assistant pre-configured.
	</p>

	<p class="text-sm text-muted-foreground text-center">
		<a href="/faq" class="underline underline-offset-4">Learn how it works</a> under
		the hood.
	</p>

	<Alert.Root class="mt-6">
		<InfoIcon class="h-4 w-4" />
		<Alert.Title>Prerequisites</Alert.Title>
		<Alert.Description
			><p>
				Make sure you have <code class="text-sm bg-muted px-1 py-0.5 rounded"
					>opencode</code
				>
				installed and logged in before running the command below. Install opencode
				from <Link
					href="https://opencode.ai/docs/#install"
					target="_blank"
					rel="noopener noreferrer"
					class="font-medium underline underline-offset-4"
				>
					opencode.ai
				</Link> and be sure to run
				<code class="text-sm bg-muted px-1 py-0.5 rounded"
					>opencode auth login</code
				>
				to authenticate as mentioned in the <Link
					href="https://opencode.ai/docs/#configure"
					target="_blank"
					rel="noopener noreferrer"
					class="font-medium underline underline-offset-4"
				>
					docs</Link
				>.
			</p></Alert.Description
		>
	</Alert.Root>

	<Alert.Root class="mt-4">
		<InfoIcon class="h-4 w-4" />
		<Alert.Title>Service Update</Alert.Title>
		<Alert.Description>
			<p>
				We're currently experiencing some client instability. We're waiting for <Link
					href="https://github.com/sst/opencode/pull/1218"
					target="_blank"
					rel="noopener noreferrer"
					class="font-medium underline underline-offset-4"
				>
					PR #1218
				</Link> to be merged, which will allow us to use the OpenCode binary directly
				in our CLI and improve stability.
			</p>
		</Alert.Description>
	</Alert.Root>
</div>
