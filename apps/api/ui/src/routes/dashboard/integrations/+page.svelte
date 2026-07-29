<!--
	Connected TikTok creator accounts, and the sandbox canary that exercises every
	requested scope.

	Deliberately a SEPARATE page from /dashboard/account. That page manages how you
	sign in to Epicenter; this one manages accounts Epicenter may post to on your
	behalf. Mixing them would invite exactly the misreading the product must avoid:
	connecting TikTok here never adds a way to sign in, and disconnecting it never
	costs you access to Epicenter.

	Wrong-account risk is reduced by naming, not hiding: every card shows the
	display name, @username, and TikTok's own open id, plus the scopes that account
	actually granted. A creator with a dozen accounts can see which one they are
	about to post as.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import {
		ConfirmationDialog,
		confirmationDialog,
	} from '@epicenter/ui/confirmation-dialog';
	import { Label } from '@epicenter/ui/label';
	import { Separator } from '@epicenter/ui/separator';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy, onMount } from 'svelte';
	import {
		COMMERCIAL_LABELS,
		DECLARATION_TEXT,
		declarationFor,
		type PublicConnection,
		type TikTokCreatorInfo,
		type TikTokPrivacyLevel,
		type TikTokVideo,
		tiktok,
		tiktokApi,
		tiktokKeys,
	} from '$lib/integrations/tiktok';
	import { auth } from '$lib/platform/auth';
	import { queryClient } from '$lib/query/client';

	const connectionsQuery = createQuery(() => tiktok.connections.options);
	const view = $derived(connectionsQuery.data ?? null);
	const connections = $derived(view?.connections ?? []);

	let selectedId = $state<string | null>(null);
	const selected = $derived(
		connections.find((connection) => connection.id === selectedId) ?? null,
	);

	// Canary state. `creatorInfo` is re-read every time a posting surface opens,
	// because TikTok requires the creator to consent against CURRENT options.
	let creatorInfo = $state<TikTokCreatorInfo | null>(null);
	let creatorInfoLoading = $state(false);
	let videos = $state<TikTokVideo[] | null>(null);
	let lastPublish = $state<{
		connectionId: string;
		publishId: string;
		kind: string;
		message: string;
	} | null>(null);
	let statusLine = $state<string | null>(null);
	let busy = $state(false);

	let videoFile = $state<File | null>(null);
	/** Object URL for the preview. Revoked whenever the file is replaced. */
	let videoPreviewUrl = $state<string | null>(null);
	/**
	 * Decoded length of the SELECTED file, read from the preview element rather
	 * than assumed. `null` until the browser reports metadata.
	 */
	let videoDurationSec = $state<number | null>(null);
	let videoUnreadable = $state(false);

	let title = $state('');
	/** No default: TikTok requires the creator to pick an audience deliberately. */
	let privacyLevel = $state<TikTokPrivacyLevel | ''>('');

	// Interaction controls are OPT-IN and every one starts unchecked, which is
	// how the content sharing guidelines require them to be presented.
	let allowComment = $state(false);
	let allowDuet = $state(false);
	let allowStitch = $state(false);

	// One commercial disclosure toggle, OFF by default. The two kinds only exist
	// once it is on.
	let commercialContent = $state(false);
	let yourBrand = $state(false);
	let brandedContent = $state(false);

	/** A separate, permanent claim, independent of the commercial disclosure. */
	let aiGenerated = $state(false);

	const maxDurationSec = $derived(creatorInfo?.maxVideoDurationSec ?? 0);
	const durationExceeded = $derived(
		videoDurationSec !== null &&
			maxDurationSec > 0 &&
			videoDurationSec > maxDurationSec,
	);

	/** Branded content is only "selected" while the disclosure is actually on. */
	const brandedSelected = $derived(commercialContent && brandedContent);

	/**
	 * The three opt-in interaction controls as data, so the markup renders one
	 * shape three times instead of branching on a key inside the handler.
	 */
	const interactionRows = $derived([
		{
			key: 'comment',
			label: 'Comment',
			checked: allowComment,
			unavailable: creatorInfo?.commentDisabled ?? false,
			set: (next: boolean) => (allowComment = next),
		},
		{
			key: 'duet',
			label: 'Duet',
			checked: allowDuet,
			unavailable: creatorInfo?.duetDisabled ?? false,
			set: (next: boolean) => (allowDuet = next),
		},
		{
			key: 'stitch',
			label: 'Stitch',
			checked: allowStitch,
			unavailable: creatorInfo?.stitchDisabled ?? false,
			set: (next: boolean) => (allowStitch = next),
		},
	]);

	/** Branded content cannot be private, so the pairing is blocked before submit. */
	const brandedPrivateConflict = $derived(
		commercialContent && brandedContent && privacyLevel === 'SELF_ONLY',
	);
	const commercialKindMissing = $derived(
		commercialContent && !yourBrand && !brandedContent,
	);

	/** The exact agreement this configuration requires, shown before publishing. */
	const declaration = $derived(
		DECLARATION_TEXT[
			declarationFor({
				disclosed: commercialContent,
				yourBrand,
				brandedContent,
			})
		],
	);

	/** Every reason the Direct Post button stays disabled, in creator language. */
	const directPostBlockers = $derived.by(() => {
		const blockers: string[] = [];
		if (!videoFile) blockers.push('Choose a video.');
		if (title.trim().length === 0) blockers.push('Write a caption.');
		if (!privacyLevel) blockers.push('Choose who can see this post.');
		if (durationExceeded) {
			blockers.push(
				`This video is ${Math.round(videoDurationSec ?? 0)}s; this account allows at most ${maxDurationSec}s.`,
			);
		}
		if (commercialKindMissing) {
			blockers.push('Select Your brand, Branded content, or both.');
		}
		if (brandedPrivateConflict) {
			blockers.push('Branded content cannot be private.');
		}
		return blockers;
	});

	/**
	 * Swap in a newly chosen file: revoke the previous object URL so a long
	 * session does not leak them, and reset the measured duration so a stale
	 * length can never authorize a new file.
	 */
	function selectVideoFile(file: File | null) {
		if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
		videoFile = file;
		videoPreviewUrl = file ? URL.createObjectURL(file) : null;
		videoDurationSec = null;
		videoUnreadable = false;
	}

	const PRIVACY_LABELS: Record<TikTokPrivacyLevel, string> = {
		PUBLIC_TO_EVERYONE: 'Public to everyone',
		MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual follows)',
		FOLLOWER_OF_CREATOR: 'Followers',
		SELF_ONLY: 'Only me (private)',
	};

	function invalidateConnections() {
		queryClient.invalidateQueries({ queryKey: tiktokKeys.connections });
	}

	function formatDate(value: string): string {
		return new Date(value).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		});
	}

	/**
	 * The connect and disconnect routes hold a FRESH session, the same bar
	 * Epicenter already applies to changing login methods. The remedy is a
	 * re-sign-in, and it must sign out first so the new session's `createdAt` is
	 * actually fresh.
	 */
	function reauthToast() {
		toast.error('Sign in again to change your connected TikTok accounts.', {
			action: {
				label: 'Sign in',
				onClick: async () => {
					await auth.signOut();
					await auth.startSignIn();
				},
			},
		});
	}

	function report(error: { message: string; code?: string; status?: number }) {
		if (error.code === 'SESSION_NOT_FRESH' || error.status === 401) {
			reauthToast();
			return;
		}
		toast.error(error.message);
	}

	// A preview object URL outlives the element unless it is revoked, so the last
	// one is released when the page unmounts (replacements are revoked in
	// selectVideoFile).
	onDestroy(() => {
		if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
	});

	// The callback returns here with ?connected=<id> or ?error=<message>. Surface
	// it once, then strip the params so a reload does not re-toast a stale result.
	onMount(() => {
		const url = new URL(window.location.href);
		const failure = url.searchParams.get('error');
		const connected = url.searchParams.get('connected');
		if (failure) toast.error(failure);
		if (connected) {
			toast.success('TikTok account connected.');
			selectedId = connected;
			invalidateConnections();
		}
		if (failure || connected) {
			url.searchParams.delete('error');
			url.searchParams.delete('connected');
			history.replaceState(null, '', url.pathname + url.search + url.hash);
		}
	});

	async function connect() {
		busy = true;
		const { data, error } = await tiktokApi.startConnect(window.location.pathname);
		busy = false;
		if (error) return report(error);
		// Leave for TikTok's consent screen.
		window.location.href = data.url;
	}

	function disconnect(connection: PublicConnection) {
		confirmationDialog.open({
			title: `Disconnect ${connection.displayName}`,
			description: `Epicenter will stop being able to post to @${connection.username ?? connection.openId}. This does not affect how you sign in to Epicenter.`,
			confirm: { text: 'Disconnect', variant: 'destructive' },
			onConfirm: async () => {
				const { data, error } = await tiktokApi.disconnect(connection.id);
				if (error) {
					report(error);
					throw error; // retryable: keep the dialog open
				}
				// Local deletion and provider revocation are reported separately,
				// because claiming "revoked" when TikTok refused would be a lie the
				// creator could only discover later in TikTok's own settings.
				if (data.revokedAtProvider) {
					toast.success('Disconnected and revoked at TikTok.');
				} else {
					toast.warning(
						`Removed from Epicenter, but TikTok could not be told to revoke it${data.revokeFailure ? `: ${data.revokeFailure}` : ''}. Revoke it in TikTok's app settings to be certain.`,
					);
				}
				if (selectedId === connection.id) {
					selectedId = null;
					creatorInfo = null;
					videos = null;
				}
				invalidateConnections();
			},
		});
	}

	/** TikTok requires this read before any posting surface is shown. */
	async function loadCreatorInfo(connectionId: string) {
		creatorInfoLoading = true;
		creatorInfo = null;
		const { data, error } = await tiktokApi.creatorInfo(connectionId);
		creatorInfoLoading = false;
		if (error) return report(error);
		creatorInfo = data;
		// Nothing is pre-selected: privacy has no default, and every interaction
		// opt-in returns to unchecked whenever the account's options are re-read.
		privacyLevel = '';
		// An account-wide "off" is a ceiling. The control is greyed out below; the
		// value is forced back to "not allowed" so a stale opt-in cannot survive a
		// settings change the creator made on TikTok.
		if (data.commentDisabled) allowComment = false;
		if (data.duetDisabled) allowDuet = false;
		if (data.stitchDisabled) allowStitch = false;
	}

	function selectConnection(connection: PublicConnection) {
		selectedId = connection.id;
		videos = null;
		lastPublish = null;
		statusLine = null;
		loadCreatorInfo(connection.id);
	}

	async function loadVideos(connectionId: string) {
		busy = true;
		const { data, error } = await tiktokApi.videos(connectionId);
		busy = false;
		if (error) return report(error);
		videos = data.videos;
	}

	function buildForm(kind: 'draft_upload' | 'direct_post'): FormData | null {
		if (!videoFile) {
			toast.error('Choose a video file first.');
			return null;
		}
		const form = new FormData();
		form.set('kind', kind);
		// One key per intended post. The server refuses a second init under the
		// same key, so a double click cannot originate two posts.
		form.set('idempotencyKey', crypto.randomUUID());
		form.set('video', videoFile);
		if (kind === 'direct_post') {
			form.set('title', title);
			form.set('privacyLevel', privacyLevel);
			// Sent as the creator's OPT-INS. The server owns the translation to
			// TikTok's disable_* flags so the inversion lives in exactly one place.
			form.set('allowComment', String(allowComment));
			form.set('allowDuet', String(allowDuet));
			form.set('allowStitch', String(allowStitch));
			form.set('commercialContent', String(commercialContent));
			form.set('yourBrand', String(commercialContent && yourBrand));
			form.set('brandedContent', String(commercialContent && brandedContent));
			form.set('aiGenerated', String(aiGenerated));
		}
		return form;
	}

	async function publish(kind: 'draft_upload' | 'direct_post', connectionId: string) {
		const form = buildForm(kind);
		if (!form) return;
		busy = true;
		const { data, error } = await tiktokApi.publish(connectionId, form);
		busy = false;
		if (error) return report(error);
		lastPublish = { connectionId, ...data };
		statusLine = null;
		toast.success(data.message);
	}

	/**
	 * The final, explicit consent. It restates the account, the audience, the
	 * commercial declaration, and the agreement the creator is accepting, because
	 * this is the last point before an irreversible publish.
	 */
	function confirmDirectPost(connectionId: string) {
		if (directPostBlockers.length > 0) {
			toast.error(directPostBlockers[0] ?? 'This post is not ready yet.');
			return;
		}
		const audience = PRIVACY_LABELS[privacyLevel as TikTokPrivacyLevel];
		const disclosure = commercialContent
			? ` It will be labelled as ${[
					yourBrand ? 'Promotional content' : null,
					brandedContent ? 'Paid partnership' : null,
				]
					.filter(Boolean)
					.join(' and ')}.`
			: '';
		confirmationDialog.open({
			title: 'Post to TikTok now',
			description: `This posts immediately to ${selected?.displayName ?? 'this account'} as "${audience}".${disclosure} ${declaration} Publishing cannot be undone from here; you would have to delete the post in the TikTok app.`,
			confirm: { text: 'Post now' },
			onConfirm: () => publish('direct_post', connectionId),
		});
	}

	/** Remote truth. This is how an ambiguous publish is resolved, never a retry. */
	async function checkStatus() {
		if (!lastPublish) return;
		busy = true;
		const { data, error } = await tiktokApi.publishStatus(
			lastPublish.connectionId,
			lastPublish.publishId,
		);
		busy = false;
		if (error) return report(error);
		statusLine =
			data.publicPostIds.length > 0
				? `${data.code}. Public post id: ${data.publicPostIds.join(', ')}`
				: `${data.code}.${data.failReason ? ` Reason: ${data.failReason}` : ' No public post id yet (private, still processing, or awaiting moderation).'}`;
	}
</script>

<svelte:head><title>Integrations: Epicenter</title></svelte:head>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Integrations</h1>
		<p class="text-sm text-muted-foreground">
			Accounts Epicenter can publish to on your behalf. These are separate from
			how you sign in to Epicenter.
		</p>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>TikTok</Card.Title>
			<Card.Description>
				Connect one or more TikTok creator accounts. Connecting an account here
				never adds a way to sign in to Epicenter, and disconnecting it never
				affects your Epicenter account.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if connectionsQuery.isLoading}
				<Spinner class="size-4" />
			{:else if connectionsQuery.error}
				<Alert.Root variant="destructive">
					<CircleAlertIcon class="size-4" />
					<Alert.Description>
						{connectionsQuery.error.message || 'Could not load connected accounts.'}
					</Alert.Description>
				</Alert.Root>
			{:else if view && !view.configured}
				<Alert.Root>
					<CircleAlertIcon class="size-4" />
					<Alert.Description class="space-y-2">
						<p>
							TikTok publishing is not configured on this deployment yet. Set
							<code>TIKTOK_CLIENT_KEY</code>, <code>TIKTOK_CLIENT_SECRET</code>,
							and <code>TIKTOK_TOKEN_ENCRYPTION_KEY</code>.
						</p>
						<p class="text-xs">
							Redirect URI to register in the TikTok developer portal:
							<code class="break-all">{view.redirectUri}</code>
						</p>
					</Alert.Description>
				</Alert.Root>
			{:else if view}
				{#if connections.length > 0}
					<ul class="flex flex-col divide-y rounded-md border">
						{#each connections as connection (connection.id)}
							<li class="flex items-start justify-between gap-3 px-4 py-3">
								<div class="flex flex-col gap-1">
									<div class="flex items-center gap-2">
										<span class="text-sm font-medium">{connection.displayName}</span>
										{#if connection.username}
											<span class="text-xs text-muted-foreground">
												@{connection.username}
											</span>
										{/if}
									</div>
									<!-- The open id disambiguates two accounts with the same
									     display name, which is the real wrong-account risk. -->
									<span class="text-[11px] text-muted-foreground break-all">
										TikTok id: {connection.openId}
									</span>
									<div class="flex flex-wrap gap-1 pt-1">
										{#each connection.scopes as scope (scope)}
											<Badge variant="secondary" class="text-[10px] px-1.5 py-0">
												{scope}
											</Badge>
										{/each}
										{#if connection.scopes.length === 0}
											<span class="text-xs text-destructive">
												No permissions granted. Reconnect to grant them.
											</span>
										{/if}
									</div>
									<span class="text-xs text-muted-foreground">
										Connected {formatDate(connection.createdAt)} · authorization
										expires {formatDate(connection.refreshTokenExpiresAt)}
									</span>
								</div>
								<div class="flex shrink-0 items-center gap-1">
									<Button
										variant={selectedId === connection.id ? 'secondary' : 'ghost'}
										size="sm"
										onclick={() => selectConnection(connection)}
									>
										{selectedId === connection.id ? 'Selected' : 'Select'}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onclick={() => disconnect(connection)}
									>
										Disconnect
									</Button>
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">
						No TikTok accounts connected yet.
					</p>
				{/if}

				<div class="flex flex-col gap-2">
					<Button variant="outline" class="self-start" disabled={busy} onclick={connect}>
						Connect a TikTok account
					</Button>
					<p class="text-xs text-muted-foreground">
						Epicenter will ask TikTok for: {view.requestedScopes.join(', ')}. You
						can approve them individually; whatever you grant is shown above.
					</p>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Canary: exercises every requested scope, in the order app review expects. -->
	{#if selected}
		<Card.Root>
			<Card.Header>
				<Card.Title>Sandbox canary: {selected.displayName}</Card.Title>
				<Card.Description>
					Exercises each permission this account granted: read the creator's
					current options, upload a draft, Direct Post, and read posts back.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-5">
				<!-- 1. user.info.basic + creator_info -->
				<section class="flex flex-col gap-2">
					<div class="flex items-center justify-between">
						<h3 class="text-sm font-medium">Current posting options</h3>
						<Button
							variant="ghost"
							size="sm"
							disabled={creatorInfoLoading}
							onclick={() => loadCreatorInfo(selected.id)}
						>
							<RefreshCwIcon class="size-3.5" />
							Re-read
						</Button>
					</div>
					{#if creatorInfoLoading}
						<Spinner class="size-4" />
					{:else if creatorInfo}
						<p class="text-xs text-muted-foreground">
							{creatorInfo.nickname}
							{#if creatorInfo.username}(@{creatorInfo.username}){/if} · max
							video {creatorInfo.maxVideoDurationSec}s
						</p>
						<p class="text-xs text-muted-foreground">
							Interactions switched off account-wide:
							{[
								creatorInfo.commentDisabled ? 'comments' : null,
								creatorInfo.duetDisabled ? 'Duet' : null,
								creatorInfo.stitchDisabled ? 'Stitch' : null,
							]
								.filter(Boolean)
								.join(', ') || 'none'}
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">
							Not loaded. TikTok requires this before posting.
						</p>
					{/if}
				</section>

				<Separator />

				<!-- 2. The video -->
				<section class="flex flex-col gap-2">
					<Label for="tiktok-video">Video (MP4, one upload chunk)</Label>
					<input
						id="tiktok-video"
						type="file"
						accept="video/mp4"
						class="text-sm"
						onchange={(event) => {
							selectVideoFile(event.currentTarget.files?.[0] ?? null);
						}}
					/>

					<!-- An ACTUAL preview of the selected video, required before publishing so
					     the creator can confirm what they are posting. `loadedmetadata` is also
					     where the real duration comes from. -->
					{#if videoPreviewUrl}
						<video
							src={videoPreviewUrl}
							controls
							preload="metadata"
							class="w-full max-w-sm rounded-md border bg-black"
							onloadedmetadata={(event) => {
								const seconds = event.currentTarget.duration;
								videoDurationSec = Number.isFinite(seconds) ? seconds : null;
								videoUnreadable = videoDurationSec === null;
							}}
							onerror={() => {
								videoDurationSec = null;
								videoUnreadable = true;
							}}
						>
							<track kind="captions" />
						</video>

						{#if videoDurationSec !== null}
							<p
								class="text-xs {durationExceeded
									? 'text-destructive'
									: 'text-muted-foreground'}"
							>
								Length {Math.round(videoDurationSec)}s{maxDurationSec > 0
									? ` of ${maxDurationSec}s allowed for this account`
									: ''}
							</p>
						{:else if videoUnreadable}
							<p class="text-xs text-muted-foreground">
								This browser could not read the video's length. Epicenter checks it
								again on the server, and TikTok checks it too.
							</p>
						{/if}

						{#if durationExceeded}
							<Alert.Root variant="destructive">
								<CircleAlertIcon class="size-4" />
								<Alert.Description>
									This video is {Math.round(videoDurationSec ?? 0)} seconds, longer than
									the {maxDurationSec} seconds this TikTok account can post. Trim it
									before publishing.
								</Alert.Description>
							</Alert.Root>
						{/if}
					{/if}
				</section>

				<!-- 3. video.upload: draft to inbox -->
				<section class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Send as a draft (video.upload)</h3>
					<p class="text-xs text-muted-foreground">
						Nothing is published. The video lands in this account's TikTok inbox,
						where the creator finishes and posts it in the app.
					</p>
					<Button
						variant="outline"
						class="self-start"
						disabled={busy || !videoFile || durationExceeded}
						onclick={() => publish('draft_upload', selected.id)}
					>
						Upload draft
					</Button>
				</section>

				<Separator />

				<!-- 4. video.publish: Direct Post -->
				<section class="flex flex-col gap-4">
					<h3 class="text-sm font-medium">Post directly (video.publish)</h3>

					<div class="flex flex-col gap-1.5">
						<Label for="tiktok-title">Caption</Label>
						<!-- Stays editable right up to publishing. -->
						<Textarea id="tiktok-title" bind:value={title} rows={2} />
					</div>

					<div class="flex flex-col gap-1.5">
						<Label for="tiktok-privacy">Who can see this post</Label>
						<!-- No default. Only levels TikTok currently offers this account are
						     listed, and the server re-checks against a live read. -->
						<select
							id="tiktok-privacy"
							bind:value={privacyLevel}
							class="h-9 rounded-md border bg-background px-3 text-sm"
							disabled={!creatorInfo}
						>
							<option value="">Select who can see this post…</option>
							{#each creatorInfo?.privacyLevelOptions ?? [] as level (level)}
								<option value={level} disabled={level === 'SELF_ONLY' && brandedSelected}>
									{PRIVACY_LABELS[level]}{level === 'SELF_ONLY' && brandedSelected
										? ' (unavailable for branded content)'
										: ''}
								</option>
							{/each}
						</select>
					</div>

					<!-- Opt-IN interaction controls, all unchecked by default. One the account
					     switched off account-wide is greyed out, because a single post cannot
					     switch it back on. -->
					<div class="flex flex-col gap-2">
						<span class="text-sm font-medium">Allow users to</span>
						{#each interactionRows as row (row.key)}
							<label
								class="flex items-center gap-2 text-sm {row.unavailable
									? 'text-muted-foreground opacity-60'
									: ''}"
							>
								<Checkbox
									checked={row.checked}
									disabled={row.unavailable}
									onCheckedChange={(value) => row.set(value === true)}
								/>
								{row.label}
								{#if row.unavailable}
									<span class="text-xs">(turned off for this account on TikTok)</span>
								{/if}
							</label>
						{/each}
					</div>

					<!-- ONE commercial disclosure toggle, off by default. The two kinds appear
					     only once it is on. -->
					<div class="flex flex-col gap-2 rounded-md border p-3">
						<label class="flex items-start gap-2 text-sm font-medium">
							<Checkbox
								checked={commercialContent}
								onCheckedChange={(value) => {
									commercialContent = value === true;
									// Turning the disclosure off clears both kinds, so a hidden
									// selection can never be published.
									if (!commercialContent) {
										yourBrand = false;
										brandedContent = false;
									}
								}}
							/>
							<span>
								Disclose video content
								<span class="block text-xs font-normal text-muted-foreground">
									Turn on to declare that this post promotes a brand, product, or
									service.
								</span>
							</span>
						</label>

						{#if commercialContent}
							<div class="flex flex-col gap-2 pl-6">
								<label class="flex items-start gap-2 text-sm">
									<Checkbox
										checked={yourBrand}
										onCheckedChange={(value) => (yourBrand = value === true)}
									/>
									<span>
										{COMMERCIAL_LABELS.yourBrand.title}
										<span class="block text-xs text-muted-foreground">
											{COMMERCIAL_LABELS.yourBrand.explanation}
										</span>
									</span>
								</label>
								<label class="flex items-start gap-2 text-sm">
									<Checkbox
										checked={brandedContent}
										onCheckedChange={(value) => (brandedContent = value === true)}
									/>
									<span>
										{COMMERCIAL_LABELS.brandedContent.title}
										<span class="block text-xs text-muted-foreground">
											{COMMERCIAL_LABELS.brandedContent.explanation}
										</span>
									</span>
								</label>

								{#if commercialKindMissing}
									<p class="text-xs text-destructive">
										Select at least one: Your brand, Branded content, or both.
									</p>
								{/if}
								{#if brandedPrivateConflict}
									<p class="text-xs text-destructive">
										Branded content cannot be private. Choose a different audience, or
										turn off Branded content.
									</p>
								{/if}
							</div>
						{/if}
					</div>

					<label class="flex items-start gap-2 text-sm">
						<Checkbox
							checked={aiGenerated}
							onCheckedChange={(value) => (aiGenerated = value === true)}
						/>
						<span>
							AI-generated content
							<span class="block text-xs text-muted-foreground">
								TikTok applies a permanent AI-generated label. This is separate from
								the commercial disclosure above.
							</span>
						</span>
					</label>

					<!-- The declaration this exact configuration requires. It changes with the
					     commercial disclosure, so it is derived rather than fixed. -->
					<p class="text-xs text-muted-foreground">{declaration}</p>

					{#if directPostBlockers.length > 0}
						<ul class="flex flex-col gap-1 text-xs text-muted-foreground">
							{#each directPostBlockers as blocker (blocker)}
								<li>{blocker}</li>
							{/each}
						</ul>
					{/if}

					<Button
						class="self-start"
						disabled={busy || directPostBlockers.length > 0}
						onclick={() => confirmDirectPost(selected.id)}
					>
						Post to TikTok now
					</Button>

					<p class="text-xs text-muted-foreground">
						TikTok processes and moderates posts after they are sent, which can take
						several minutes. Check the status below to see the outcome.
					</p>
				</section>

				<!-- 5. Resolve the outcome by reading, never by retrying -->
				{#if lastPublish}
					<Separator />
					<section class="flex flex-col gap-2">
						<h3 class="text-sm font-medium">Last publish</h3>
						<p class="text-xs text-muted-foreground break-all">
							{lastPublish.kind} · publish id {lastPublish.publishId}
						</p>
						<p class="text-xs text-muted-foreground">{lastPublish.message}</p>
						<div class="flex items-center gap-2">
							<Button variant="outline" size="sm" disabled={busy} onclick={checkStatus}>
								Check status
							</Button>
						</div>
						{#if statusLine}
							<p class="text-xs">{statusLine}</p>
						{/if}
					</section>
				{/if}

				<Separator />

				<!-- 6. video.list -->
				<section class="flex flex-col gap-2">
					<div class="flex items-center justify-between">
						<h3 class="text-sm font-medium">Recent posts (video.list)</h3>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onclick={() => loadVideos(selected.id)}
						>
							Load
						</Button>
					</div>
					{#if videos}
						{#if videos.length > 0}
							<ul class="flex flex-col divide-y rounded-md border text-sm">
								{#each videos as video (video.id)}
									<li class="flex flex-col gap-0.5 px-3 py-2">
										<span>{video.title || video.description || '(no caption)'}</span>
										<a
											class="text-xs text-muted-foreground underline break-all"
											href={video.shareUrl}
											target="_blank"
											rel="noreferrer noopener"
										>
											{video.shareUrl}
										</a>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="text-xs text-muted-foreground">No posts returned.</p>
						{/if}
					{/if}
				</section>
			</Card.Content>
		</Card.Root>
	{/if}
</div>

<ConfirmationDialog />
