<script lang="ts">
	import * as Accordion from '@repo/ui/accordion';
	import { Link } from '@repo/ui/link';
	import { PMCommand } from '@repo/ui/pm-command';
</script>

<svelte:head>
	<title>FAQ - epicenter.sh</title>
	<meta
		name="description"
		content="Frequently asked questions about epicenter.sh and the epicenter CLI"
	/>
</svelte:head>

<div class="container mx-auto max-w-4xl px-4 py-8">
	<h1 class="text-4xl font-bold tracking-tight mb-8">
		Frequently Asked Questions
	</h1>

	<Accordion.Root type="single" collapsible class="space-y-4">
		<Accordion.Item value="how-it-works">
			<Accordion.Trigger class="text-left">
				How does the epicenter CLI work under the hood?
			</Accordion.Trigger>
			<Accordion.Content>
				<div class="space-y-4 pt-4">
					<p>
						The epicenter CLI runs a custom fork of the
						<Link
							href="https://github.com/sst/opencode"
							target="_blank"
							rel="noopener noreferrer"
						>
							sst/opencode
						</Link>
						repository that we maintain at
						<Link
							href="https://github.com/epicenter-md/opencode"
							target="_blank"
							rel="noopener noreferrer"
						>
							@epicenter/opencode
						</Link>. This fork adds essential CORS (Cross-Origin Resource
						Sharing) support, allowing epicenter.sh to communicate with your
						local OpenCode server from the browser.
					</p>

					<p>When you run the CLI command, it:</p>
					<ol class="list-decimal list-inside space-y-2 ml-4">
						<li>Starts an OpenCode server on your local machine</li>
						<li>Configures CORS to accept requests from epicenter.sh</li>
						<li>
							Creates a secure tunnel (via Cloudflare or ngrok) to expose your
							local server
						</li>
						<li>Opens epicenter.sh with your assistant pre-configured</li>
					</ol>

					<p>
						Your code never leaves your machine. The tunnel only allows the AI
						assistant to communicate with your OpenCode server; all processing
						happens locally.
					</p>
				</div>
			</Accordion.Content>
		</Accordion.Item>

		<Accordion.Item value="why-bun">
			<Accordion.Trigger class="text-left">
				Why does the CLI require Bun instead of Node.js?
			</Accordion.Trigger>
			<Accordion.Content>
				<div class="space-y-4 pt-4">
					<p>
						The upstream <Link
							href="https://github.com/sst/opencode"
							target="_blank"
							rel="noopener noreferrer">sst/opencode</Link
						>
						project uses Bun-specific syntax and APIs (like the $ shell operator)
						that aren't available in Node.js. Since our fork maintains compatibility
						with upstream, we also require Bun.
					</p>
					<p>
						We don't ship a standalone binary yet because we want to keep things
						lean and avoid polluting your system's namespace. Using <code
							>bunx</code
						> ensures you always get the latest version without manual updates.
					</p>
				</div>
			</Accordion.Content>
		</Accordion.Item>

		<Accordion.Item value="security">
			<Accordion.Trigger class="text-left">
				Is it secure to use tunnels with my code?
			</Accordion.Trigger>
			<Accordion.Content>
				<div class="space-y-4 pt-4">
					<p>Yes, when configured properly. Here's how security works:</p>

					<ul class="list-disc list-inside space-y-2 ml-4">
						<li>
							<strong>Password protection</strong>: Your OpenCode server
							requires a password for all API access
						</li>
						<li>
							<strong>CORS restrictions</strong>: Only epicenter.sh (and any
							domains you explicitly allow) can make requests
						</li>
						<li>
							<strong>Encrypted tunnels</strong>: Both Cloudflare and ngrok
							provide HTTPS encryption for all traffic
						</li>
						<li>
							<strong>Local processing</strong>: Your code never leaves your
							machine; only API commands are transmitted
						</li>
					</ul>

					<p>
						For maximum security, you can also run OpenCode without a tunnel and
						only access it locally at <code>http://localhost:&lt;port&gt;</code
						>.
					</p>
				</div>
			</Accordion.Content>
		</Accordion.Item>

		<Accordion.Item value="tunnel-providers">
			<Accordion.Trigger class="text-left">
				What's the difference between Cloudflare and ngrok tunnels?
			</Accordion.Trigger>
			<Accordion.Content>
				<div class="space-y-4 pt-4">
					<p>
						Both tunnel providers work well, but they have different
						characteristics:
					</p>

					<div class="space-y-4">
						<div>
							<h4 class="font-semibold">Cloudflare (default)</h4>
							<ul class="list-disc list-inside space-y-1 ml-4 text-sm">
								<li>No account required for anonymous usage</li>
								<li>Better DDoS protection</li>
								<li>Slightly faster in most regions</li>
								<li>Temporary URLs that change each session</li>
							</ul>
						</div>

						<div>
							<h4 class="font-semibold">ngrok</h4>
							<ul class="list-disc list-inside space-y-1 ml-4 text-sm">
								<li>Free tier limited to one tunnel at a time</li>
								<li>More established service</li>
								<li>Can get persistent URLs with a paid account</li>
								<li>Better debugging tools in their web interface</li>
							</ul>
						</div>
					</div>

					<p>To use ngrok instead of Cloudflare:</p>
					<PMCommand
						command="execute"
						args={['@epicenter/cli@latest', 'sh', '--tunnel=ngrok']}
						agent="bun"
						agents={['bun']}
					/>
				</div>
			</Accordion.Content>
		</Accordion.Item>

		<Accordion.Item value="cors-origins">
			<Accordion.Trigger class="text-left">
				Can I use epicenter CLI with my own frontend?
			</Accordion.Trigger>
			<Accordion.Content>
				<div class="space-y-4 pt-4">
					<p>
						Yes! The CLI accepts custom CORS origins. You can allow your own
						domains to communicate with the OpenCode server:
					</p>

					<PMCommand
						command="execute"
						args={[
							'@epicenter/cli@latest',
							'sh',
							'--cors-origins',
							'https://epicenter.sh',
							'https://your-domain.com',
						]}
						agent="bun"
						agents={['bun']}
					/>

					<p>This is useful if you're:</p>
					<ul class="list-disc list-inside space-y-1 ml-4">
						<li>Building your own AI coding interface</li>
						<li>Integrating OpenCode into an existing application</li>
						<li>Running epicenter.sh from a custom domain</li>
					</ul>
				</div>
			</Accordion.Content>
		</Accordion.Item>

		<Accordion.Item value="local-development">
			<Accordion.Trigger class="text-left">
				How do I run everything locally without tunnels?
			</Accordion.Trigger>
			<Accordion.Content>
				<div class="space-y-4 pt-4">
					<p>You can run OpenCode without any tunnels for local development:</p>

					<PMCommand
						command="execute"
						args={['@epicenter/cli@latest', 'sh', '--no-tunnel', '--no-open']}
						agent="bun"
						agents={['bun']}
					/>

					<p>
						This starts the server on <code>http://localhost:4096</code> (or another
						available port). You'll need to manually add the assistant in the epicenter.sh
						interface using the local URL.
					</p>

					<p>
						For local development of epicenter.sh itself, add localhost to CORS
						origins:
					</p>

					<PMCommand
						command="execute"
						args={[
							'@epicenter/cli@latest',
							'sh',
							'--no-tunnel',
							'--cors-origins',
							'https://epicenter.sh',
							'http://localhost:5173',
						]}
						agent="bun"
						agents={['bun']}
					/>
				</div>
			</Accordion.Content>
		</Accordion.Item>

		<Accordion.Item value="data-storage">
			<Accordion.Trigger class="text-left">
				Where is my data stored?
			</Accordion.Trigger>
			<Accordion.Content>
				<div class="space-y-4 pt-4">
					<p>All your data is stored locally on your machine:</p>

					<ul class="list-disc list-inside space-y-2 ml-4">
						<li>
							<strong>Assistant configurations</strong>: Stored in your
							browser's localStorage under the key
							<code>opencode-assistant-configs</code>
						</li>
						<li>
							<strong>Session data</strong>: Managed by your OpenCode server on
							your local machine
						</li>
						<li>
							<strong>Chat history</strong>: Persisted by OpenCode in your
							project directory
						</li>
						<li>
							<strong>No cloud storage</strong>: epicenter.sh does not store any
							of your data on remote servers
						</li>
					</ul>

					<p>
						This means your assistant configurations are tied to your browser.
						If you clear your browser data or use a different browser, you'll
						need to reconfigure your assistants. Your actual code and chat
						history remain safe on your local machine as they're managed by
						OpenCode.
					</p>

					<p>
						For backup purposes, you can export your localStorage data from your
						browser's developer console if needed.
					</p>
				</div>
			</Accordion.Content>
		</Accordion.Item>
	</Accordion.Root>

	<div class="mt-12 p-6 bg-muted/50 rounded-lg">
		<h2 class="text-lg font-semibold mb-2">Still have questions?</h2>
		<p class="text-sm text-muted-foreground">
			Check out the
			<Link
				href="https://github.com/epicenter-md/opencode"
				target="_blank"
				rel="noopener noreferrer"
			>
				@epicenter/opencode
			</Link>
			repository or open an issue on GitHub. We're happy to help!
		</p>
	</div>
</div>
