<!--
	Post one video to one connected TikTok creator account.

	Every required item from TikTok's content sharing guidelines is here, in the
	order a creator meets them: the account's CURRENT posting options read fresh,
	a preview of the actual file, an editable caption, an audience with no default,
	opt-in interaction controls that grey out what the account switched off, the
	commercial disclosure and its two kinds, the AI-generated declaration, the
	exact agreement text, an explicit confirmation, and then the post followed to
	TikTok's own terminal status.

	Scoped to ONE connection on purpose. The parent renders it inside `{#key}`, so
	switching creators rebuilds this component and every choice resets to its
	unselected state structurally. Nothing here has to remember to clear itself,
	which is the bug class a shared form would keep reintroducing.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Label } from '@epicenter/ui/label';
	import { Separator } from '@epicenter/ui/separator';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { onDestroy, onMount } from 'svelte';
	import { createFollowGate } from '$lib/integrations/follow-gate';
	import {
		type AttemptTone,
		attemptPhase,
		blocksNewPublish,
		COMMERCIAL_LABELS,
		createPublishIntentKeeper,
		createSessionIntentKeyStore,
		DECLARATION_TEXT,
		declarationFor,
		describeAttemptStatus,
		canReadRemoteStatus,
		isAmbiguousPublishFailure,
		isTerminalAttemptStatus,
		type ManualResolution,
		pickAttemptToFollow,
		type PublicConnection,
		type PublishAttempt,
		type PublishIntent,
		type PublishStatusView,
		requiresManualResolution,
		type TikTokCreatorInfo,
		type TikTokPrivacyLevel,
		tiktokApi,
	} from '$lib/integrations/tiktok';

	const { connection }: { connection: PublicConnection } = $props();

	/** How a creator reads each audience TikTok may offer. */
	const PRIVACY_LABELS: Record<TikTokPrivacyLevel, string> = {
		PUBLIC_TO_EVERYONE: 'Everyone',
		MUTUAL_FOLLOW_FRIENDS: 'Friends (people you follow back)',
		FOLLOWER_OF_CREATOR: 'Your followers',
		SELF_ONLY: 'Only you (private)',
	};

	/**
	 * How long to wait between status reads, then the ceiling.
	 *
	 * Front-loaded because most posts settle quickly, and TikTok rate-limits, so a
	 * fixed one-second poll would spend its budget before moderation finishes on a
	 * post that needs minutes.
	 */
	const FOLLOW_DELAYS_MS = [3_000, 3_000, 5_000, 5_000, 10_000, 15_000, 30_000];
	/**
	 * When to stop polling and hand the creator a manual check instead. TikTok
	 * moderation can outlast any reasonable open-tab window, and a page that polls
	 * forever is worse than one that says "still processing, check again".
	 */
	const FOLLOW_BUDGET_MS = 10 * 60_000;

	// --- The account's current options ---------------------------------------

	/**
	 * Re-read on mount and on demand, never cached. The creator consents against
	 * what TikTok says RIGHT NOW: available audiences and interaction ceilings can
	 * both change between opening this page and pressing post.
	 */
	let creatorInfo = $state<TikTokCreatorInfo | null>(null);
	let creatorInfoLoading = $state(false);
	let creatorInfoError = $state<string | null>(null);

	// --- The post being composed ---------------------------------------------

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

	let posting = $state(false);

	// --- What happened to it -------------------------------------------------

	let attempts = $state<PublishAttempt[]>([]);
	/** The publishing task this surface is currently following. */
	let trackedPublishId = $state<string | null>(null);
	let following = $state(false);
	/** Set when polling ran out of budget without reaching a terminal status. */
	let followGaveUp = $state(false);
	/** A failed status READ, which is not a failed post. */
	let followError = $state<string | null>(null);
	/**
	 * TikTok's answer for a task with no local row to reconcile: the documented
	 * window where the init succeeded but persisting its publish id did not.
	 */
	let unrecordedStatus = $state<PublishStatusView | null>(null);
	/**
	 * What the last submit reported, when the answer was not simply "accepted".
	 *
	 * Transient and for MESSAGING ONLY. The block itself is derived from the
	 * durable rows below, because a message held in a variable does not survive a
	 * reload, an account switch, or a closed tab, and the block has to.
	 */
	let submitNotice = $state<string | null>(null);
	/** Which attempt the creator is recording an outcome for, while it is in flight. */
	let resolving = $state<string | null>(null);
	/**
	 * A ticking clock, because whether an attempt may be adjudicated by hand depends
	 * on a LEASE expiring rather than on anything arriving from the server.
	 *
	 * Without it, a page open across the moment a lease runs out would keep saying
	 * "sending" forever: an attempt with no publish id is never polled, so nothing
	 * else would re-render. The interval only runs while an active attempt is on
	 * screen (see the effect below), so a settled surface costs nothing.
	 */
	let now = $state(Date.now());

	/**
	 * Owns the idempotency key across retries AND across reloads. Backed by
	 * sessionStorage because reloading is the natural reaction to a stalled
	 * request, and a keeper that only lived in this module would lose the claim
	 * exactly when it matters most. Degrades to in-memory when storage is
	 * unavailable; see publish-intent.ts.
	 */
	const keeper = createPublishIntentKeeper(
		() => crypto.randomUUID(),
		createSessionIntentKeyStore(
			typeof sessionStorage === 'undefined' ? null : sessionStorage,
		),
	);

	/**
	 * Who this post is going to, preferring the LIVE `creator_info` read.
	 *
	 * The guidelines require the account that will receive the content to be named
	 * from the latest creator info, not from whatever was stored at connect time.
	 * The difference is real: a creator who renamed on TikTok since connecting
	 * would otherwise be shown a name that no longer exists.
	 *
	 * The stored connection is a fallback for THIS HEADER ONLY, covering the moment
	 * before the live read lands. The final confirmation in `confirmPost` refuses to
	 * fall back at all: approving an irreversible post against a stale identity is
	 * the failure this is guarding, and a header shown while loading is not that.
	 */
	const postingAs = $derived({
		name: creatorInfo?.nickname || connection.displayName,
		handle: creatorInfo?.username || connection.username,
	});

	const maxDurationSec = $derived(creatorInfo?.maxVideoDurationSec ?? 0);
	const durationExceeded = $derived(
		videoDurationSec !== null &&
			maxDurationSec > 0 &&
			videoDurationSec > maxDurationSec,
	);

	/** Branded content is only "selected" while the disclosure is actually on. */
	const brandedSelected = $derived(commercialContent && brandedContent);
	/** Branded content cannot be private, so the pairing is blocked before submit. */
	const brandedPrivateConflict = $derived(
		brandedSelected && privacyLevel === 'SELF_ONLY',
	);
	const commercialKindMissing = $derived(
		commercialContent && !yourBrand && !brandedContent,
	);

	/**
	 * The three opt-in interaction controls as data, so the markup renders one
	 * shape three times instead of branching on a key inside the handler.
	 */
	const interactionRows = $derived([
		{
			key: 'comment',
			label: 'Comments',
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

	/**
	 * The recorded attempt, if any, whose outcome we cannot state, and which
	 * therefore forbids another publish to this account.
	 *
	 * Derived, not stored. `blocksNewPublish` fails closed on a status this build
	 * does not recognize, so a future TikTok code blocks rather than slipping
	 * through as though it were finished.
	 */
	const blockingAttempt = $derived(
		attempts.find((attempt) => blocksNewPublish(attempt.status)) ?? null,
	);

	/**
	 * Whether a request is still allowed to be working on the blocking attempt.
	 *
	 * `active` is the healthy in-flight case and must NOT offer a manual outcome:
	 * recording "nothing was posted" on a live publish is exactly how one consent
	 * becomes a post the creator was told did not happen.
	 */
	const blockingPhase = $derived(
		blockingAttempt ? attemptPhase(blockingAttempt, now) : null,
	);

	// Tick only while something is genuinely in flight.
	$effect(() => {
		if (blockingPhase !== 'active') return;
		const timer = setInterval(() => {
			now = Date.now();
		}, 15_000);
		return () => clearInterval(timer);
	});

	/** Every reason the post button stays disabled, in creator language. */
	const blockers = $derived.by(() => {
		const reasons: string[] = [];
		/**
		 * An unknown outcome blocks everything, and the block comes from the DURABLE
		 * row rather than from a variable set when the submit failed. That is what
		 * makes it survive a reload, an account switch, and a closed tab: the fact
		 * that TikTok may be holding a post is recorded in Postgres, so it cannot be
		 * escaped by refreshing the page.
		 */
		if (blockingAttempt) {
			reasons.push(
				blockingPhase === 'active'
					? 'A post to this account is still being sent. Wait for it to finish.'
					: requiresManualResolution(blockingAttempt, now)
						? 'A previous post has an unknown outcome that only you can settle. Check TikTok and record what you found below.'
						: 'A previous post has an unknown outcome. Check its status before posting again.',
			);
		}
		if (!videoFile) reasons.push('Choose a video.');
		if (title.trim().length === 0) reasons.push('Write a caption.');
		if (!privacyLevel) reasons.push('Choose who can see this post.');
		if (durationExceeded) {
			reasons.push(
				`This video is ${Math.round(videoDurationSec ?? 0)}s; this account allows at most ${maxDurationSec}s.`,
			);
		}
		if (commercialKindMissing) {
			reasons.push('Select Your brand, Branded content, or both.');
		}
		if (brandedPrivateConflict) {
			reasons.push('Branded content cannot be private.');
		}
		return reasons;
	});

	/**
	 * The attempt being followed, read from the RECORDED rows rather than from a
	 * separate copy of TikTok's last answer. The status route reconciles the row
	 * server-side, so refreshing the list is what makes this current, and there is
	 * only ever one place a status is read from.
	 */
	const tracked = $derived(
		attempts.find((attempt) => attempt.publishId === trackedPublishId) ?? null,
	);

	/**
	 * What to show about the post in flight, from the stored row when there is one
	 * and from TikTok's bare answer when there is not.
	 *
	 * Both cases exist and neither can be dropped. Normally the reconciled row IS
	 * the answer. In the documented double-fault (TikTok created the task, saving
	 * its publish id failed) no row carries this publish id, and refusing to show
	 * the outcome would hide "your post is live" precisely when the creator is
	 * most likely to post it a second time.
	 */
	const outcome = $derived.by(() => {
		if (tracked) {
			return {
				status: tracked.status,
				failReason: tracked.failReason,
				publicPostIds: tracked.publicPostIds ?? [],
				sentAt: tracked.createdAt as string | null,
				recorded: true,
			};
		}
		if (unrecordedStatus) {
			return {
				status: unrecordedStatus.code as string | null,
				failReason: unrecordedStatus.failReason ?? null,
				publicPostIds: unrecordedStatus.publicPostIds,
				sentAt: null,
				recorded: false,
			};
		}
		return null;
	});
	const outcomeStatus = $derived(
		outcome ? describeAttemptStatus(outcome.status) : null,
	);

	/** Older attempts, so the one being followed is not listed twice. */
	const earlierAttempts = $derived(
		attempts.filter((attempt) => attempt.id !== tracked?.id),
	);

	/**
	 * Styling keyed on the CONFIDENCE of a status, not on the status itself.
	 *
	 * Typed as a total `Record<AttemptTone, string>` on purpose: adding a tone to
	 * `attempt-status.ts` then fails to compile here until this surface decides how
	 * it looks, rather than rendering an unstyled new state as though it were fine.
	 */
	const TONE_CLASS: Record<AttemptTone, string> = {
		pending: 'text-muted-foreground',
		posted: 'text-foreground',
		failed: 'text-destructive',
		unknown: 'text-destructive',
	};

	function report(error: { message: string }) {
		toast.error(error.message);
	}

	function formatTime(value: string): string {
		return new Date(value).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}

	/** TikTok requires this read before any posting surface is shown. */
	async function loadCreatorInfo() {
		creatorInfoLoading = true;
		creatorInfoError = null;
		const { data, error } = await tiktokApi.creatorInfo(connection.id);
		creatorInfoLoading = false;
		if (error) {
			creatorInfoError = error.message;
			return;
		}
		creatorInfo = data;
		// An account-wide "off" is a ceiling. The control is greyed out below; the
		// value is forced back to "not allowed" so a stale opt-in cannot survive a
		// settings change the creator made on TikTok.
		if (data.commentDisabled) allowComment = false;
		if (data.duetDisabled) allowDuet = false;
		if (data.stitchDisabled) allowStitch = false;
		// An audience TikTok has stopped offering cannot stay selected.
		if (privacyLevel && !data.privacyLevelOptions.includes(privacyLevel)) {
			privacyLevel = '';
		}
	}

	async function refreshAttempts() {
		const { data, error } = await tiktokApi.attempts(connection.id);
		if (error) return;
		attempts = data.attempts;
	}

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

	// --- Following a task to its outcome -------------------------------------

	/**
	 * Ownership of the follow loop. A run stops being the owner when a newer follow
	 * begins OR when this component is destroyed, and the gate is closed
	 * permanently on destroy so a continuation that arrives late cannot open a new
	 * run. See follow-gate.ts for the defect this prevents.
	 */
	const gate = createFollowGate();

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));

	/**
	 * Poll TikTok for this exact publish id until it reports a terminal status.
	 *
	 * Each read also reconciles the stored attempt server-side, so following a
	 * post is what makes the durable record honest: a creator who closes the tab
	 * mid-flight and returns later sees the outcome, not the state the row was
	 * left in.
	 */
	async function follow(publishId: string) {
		const isCurrent = gate.begin();
		// Checked BEFORE any state is touched, so a loop started from a continuation
		// that resolved after teardown writes nothing at all.
		if (!isCurrent()) return;
		trackedPublishId = publishId;
		following = true;
		followGaveUp = false;
		followError = null;
		const startedAt = Date.now();
		let round = 0;

		try {
			while (isCurrent()) {
				const { data, error } = await tiktokApi.publishStatus(
					connection.id,
					publishId,
				);
				if (!isCurrent()) return;
				if (error) {
					// Failing to READ a status says nothing about the post itself, so this
					// never becomes a publish failure. The manual check stays available.
					followError = error.message;
					return;
				}
				followError = null;
				unrecordedStatus = data.recorded ? null : data;
				await refreshAttempts();
				if (!isCurrent()) return;

				// TikTok says nothing further will change, so stop asking.
				if (isTerminalAttemptStatus(data.code)) {
					/**
					 * A terminal answer SETTLES the intent, whichever way it went, so the
					 * key is released and the next post starts a new one. Both directions
					 * matter: after PUBLISH_COMPLETE, posting the same video again is a
					 * genuine second post; after FAILED, nothing was published and an
					 * unchanged retry must be allowed rather than refused as a duplicate
					 * of a post that never existed.
					 */
					keeper.settle(connection.id);
					// The outcome is now KNOWN. The block itself is derived from the row,
					// which this poll just reconciled, so it lifts on its own.
					submitNotice = null;
					return;
				}
				if (Date.now() - startedAt >= FOLLOW_BUDGET_MS) {
					followGaveUp = true;
					return;
				}
				await sleep(
					FOLLOW_DELAYS_MS[Math.min(round++, FOLLOW_DELAYS_MS.length - 1)] ??
						30_000,
				);
			}
		} finally {
			if (isCurrent()) following = false;
		}
	}

	/** The manual check, and how a `followGaveUp` or read failure is retried. */
	function checkNow() {
		const publishId = trackedPublishId ?? tracked?.publishId;
		if (publishId) follow(publishId);
	}

	// --- Posting -------------------------------------------------------------

	/**
	 * Builds the intent this form currently describes. Handed to the keeper,
	 * which returns the SAME idempotency key for as long as the intent is
	 * unchanged, so a retry after a lost response reuses it.
	 */
	function currentIntent(): PublishIntent {
		return {
			connectionId: connection.id,
			file: videoFile
				? {
						name: videoFile.name,
						size: videoFile.size,
						lastModified: videoFile.lastModified,
					}
				: null,
			title,
			privacyLevel,
			allowComment,
			allowDuet,
			allowStitch,
			commercialContent,
			yourBrand: commercialContent && yourBrand,
			brandedContent: commercialContent && brandedContent,
			aiGenerated,
		};
	}

	async function post() {
		if (!videoFile) return;
		const form = new FormData();
		// NOT a fresh key per click. The keeper returns the key this intent already
		// owns, so a retry after a timeout collides with the attempt the server
		// already claimed instead of originating a second post. A new key is minted
		// only when the intent materially changes, or after a settled outcome
		// releases the old one.
		form.set('idempotencyKey', keeper.keyFor(currentIntent()));
		form.set('video', videoFile);
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

		posting = true;
		const { data, error } = await tiktokApi.publish(connection.id, form);
		posting = false;

		if (error) {
			// The rule lives in publish-intent.ts so it is unit-tested rather than
			// buried in a handler: a LOST BROWSER RESPONSE is ambiguous exactly like
			// a server-reported one, because the request may have reached the Worker,
			// which may have reached TikTok.
			if (isAmbiguousPublishFailure(error)) {
				const responseLost = error.name === 'RequestFailed';
				const publishId =
					error.name === 'ServerRefused' ? (error.publishId ?? null) : null;
				submitNotice = responseLost
					? 'The connection dropped before Epicenter saw TikTok’s answer, so this post may or may not have been created. Posting again reuses the same request, so it cannot post twice. Check below before doing anything else.'
					: error.message;
				/**
				 * Deliberately NOT `keeper.settle()`. The key must survive so a retry
				 * collides with the claim instead of starting a new intent, and this
				 * branch covers the same-key 409 as well: the server reports whether the
				 * existing attempt has settled, and while it has not, this collision IS
				 * the thing preventing a second post.
				 */
				await refreshAttempts();
				// A publish id means TikTok DID create a task, so it can still be
				// followed to a real answer even though this request failed. Without
				// one, the durable row is the block and only a human can settle it.
				if (publishId) follow(publishId);
				toast.error(submitNotice, { duration: 15_000 });
				return;
			}

			/**
			 * A definite refusal. Nothing was created, so the key is spent and a
			 * corrected post may start a new intent.
			 *
			 * Includes the server's own publish block, which refuses a new post while
			 * a prior outcome is unknown. Releasing the key is still right there:
			 * this request never reached `video/init`, and the block cannot be escaped
			 * without an explicit resolution, so the next attempt cannot slip through.
			 */
			keeper.settle(connection.id);
			report(error);
			/**
			 * Re-read the rows the server just refused against. The block is derived
			 * from them, and the server may know about an attempt this tab has not
			 * seen (another tab, or a Worker that recorded it after this page loaded),
			 * so syncing is what makes the refusal visible rather than just a toast.
			 */
			await refreshAttempts();
			return;
		}

		// Accepted: this intent is delivered and the next post starts a new one.
		keeper.settle(connection.id);
		submitNotice = null;
		unrecordedStatus = null;
		toast.success(data.message);
		await refreshAttempts();
		// Immediately start following the exact task TikTok just created.
		follow(data.publishId);
	}

	/**
	 * Record what the creator found for an attempt nothing automated can settle.
	 *
	 * The only exit from `INIT_AMBIGUOUS` or a null status: no publish id exists,
	 * so TikTok cannot be asked, and the block that protects the invariant would
	 * otherwise be permanent. Confirmed explicitly, because saying "nothing was
	 * posted" is what unlocks posting again.
	 */
	function confirmResolution(attemptId: string, outcome: ManualResolution) {
		const posted = outcome === 'RESOLVED_POSTED';
		confirmationDialog.open({
			title: posted ? 'Record that it posted' : 'Record that nothing posted',
			description: posted
				? 'Epicenter will remember that this video is on the profile. It stays recorded as your own confirmation, not as something TikTok reported.'
				: 'Epicenter will remember that nothing was posted, and will let you post to this account again. Only choose this after checking the TikTok app: if the post is actually there, posting again puts up a second copy.',
			confirm: { text: posted ? 'It posted' : 'Nothing posted' },
			onConfirm: async () => {
				resolving = attemptId;
				const { error } = await tiktokApi.resolveAttempt(
					connection.id,
					attemptId,
					outcome,
				);
				resolving = null;
				if (error) {
					report(error);
					throw error; // retryable: keep the dialog open
				}
				// A settled attempt releases this account's claim, so a corrected or
				// repeated post starts a genuinely new intent.
				keeper.settle(connection.id);
				submitNotice = null;
				await refreshAttempts();
			},
		});
	}

	/**
	 * The final, explicit consent. It restates the account, the audience, the
	 * commercial declaration, and the agreement the creator is accepting, because
	 * this is the last point before an irreversible publish.
	 */
	function confirmPost() {
		if (blockers.length > 0) {
			toast.error(blockers[0] ?? 'This post is not ready yet.');
			return;
		}
		/**
		 * The live read is REQUIRED here, with no fallback to the stored handle.
		 * `creator_info` now fails closed when TikTok omits the username, so if this
		 * is absent we genuinely do not know which account we are about to post as,
		 * and naming the connect-time handle would invite approval of an
		 * irreversible post against a stale identity.
		 */
		if (!creatorInfo) {
			toast.error(
				'Epicenter could not confirm which TikTok account this would post to. Reload and try again.',
			);
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
		// Named from the live creator info ONLY, so the last screen before an
		// irreversible post shows the account exactly as TikTok describes it now.
		const handle = `@${creatorInfo.username}`;
		confirmationDialog.open({
			title: 'Post to TikTok now',
			description: `This posts to ${handle} immediately, visible to: ${audience}.${disclosure} ${declaration} Posting cannot be undone from Epicenter; you would have to delete the post in the TikTok app.`,
			confirm: { text: 'Post now' },
			onConfirm: post,
		});
	}

	onMount(() => {
		loadCreatorInfo();
		/**
		 * Resume following a post left in flight by an earlier visit. Without this
		 * the durable row would stay wherever it was when the tab closed, which is
		 * exactly the stale "processing" this surface must never show.
		 *
		 * The gate check is load-bearing, not defensive tidiness: this continuation
		 * runs after an `await`, and switching accounts or leaving the page during
		 * that await used to start a ten-minute poll owned by a component that no
		 * longer existed. `pickAttemptToFollow` only ever returns something that can
		 * actually be polled, so this cannot spin on an attempt with no publish id.
		 */
		refreshAttempts().then(() => {
			if (gate.isClosed) return;
			const live = pickAttemptToFollow(attempts);
			if (live?.publishId) follow(live.publishId);
		});
	});

	onDestroy(() => {
		// Closes the gate PERMANENTLY, which stops the follow loop and also stops the
		// mount continuation below from starting one after teardown. Then release the
		// last preview URL (replacements are revoked in selectVideoFile).
		gate.close();
		if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
	});
</script>

<Card.Root>
	<Card.Header>
		<div class="flex items-center gap-3">
			{#if connection.avatarUrl}
				<img
					src={connection.avatarUrl}
					alt=""
					class="size-10 shrink-0 rounded-full border object-cover"
				/>
			{/if}
			<div class="flex flex-col">
				<Card.Title>Post to TikTok</Card.Title>
				<Card.Description>
					Posting as {postingAs.name}{#if postingAs.handle}
						<span class="text-foreground">&nbsp;@{postingAs.handle}</span>
					{/if}
				</Card.Description>
			</div>
		</div>
	</Card.Header>

	<Card.Content class="flex flex-col gap-5">
		{#if creatorInfoLoading && !creatorInfo}
			<div class="flex items-center gap-2 text-sm text-muted-foreground">
				<Spinner class="size-4" />
				Checking what this account can post right now…
			</div>
		{:else if creatorInfoError}
			<!--
				TikTok requires the posting surface to stop and offer a retry when the
				creator cannot post at that moment, rather than showing a form whose
				options are unknown.
			-->
			<Alert.Root variant="destructive">
				<CircleAlertIcon class="size-4" />
				<Alert.Description class="space-y-2">
					<p>{creatorInfoError}</p>
					<p class="text-xs">
						Epicenter could not read this account's current posting options, so
						it will not offer to post.
					</p>
					<Button variant="outline" size="sm" onclick={loadCreatorInfo}>
						<RefreshCwIcon class="size-3.5" />
						Try again
					</Button>
				</Alert.Description>
			</Alert.Root>
		{:else if creatorInfo}
			<!-- 1. The video, and a real preview of it -->
			<section class="flex flex-col gap-2">
				<Label for="tiktok-video">Video</Label>
				<input
					id="tiktok-video"
					type="file"
					accept="video/mp4"
					class="text-sm"
					onchange={(event) => {
						selectVideoFile(event.currentTarget.files?.[0] ?? null);
					}}
				/>
				<p class="text-xs text-muted-foreground">
					MP4{maxDurationSec > 0
						? `, up to ${maxDurationSec}s for this account`
						: ''}.
				</p>

				{#if videoPreviewUrl}
					<!--
						An ACTUAL preview of the selected video, which the guidelines
						require before publishing so the creator can confirm what they are
						posting. `loadedmetadata` is also where the real duration comes from.
					-->
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
							{Math.round(videoDurationSec)}s{maxDurationSec > 0
								? ` of ${maxDurationSec}s allowed`
								: ''}
						</p>
					{:else if videoUnreadable}
						<p class="text-xs text-muted-foreground">
							This browser could not read the video's length. Epicenter checks it
							again before posting, and TikTok checks it too.
						</p>
					{/if}

					{#if durationExceeded}
						<Alert.Root variant="destructive">
							<CircleAlertIcon class="size-4" />
							<Alert.Description>
								This video is {Math.round(videoDurationSec ?? 0)} seconds, longer
								than the {maxDurationSec} seconds this account can post. Trim it
								before posting.
							</Alert.Description>
						</Alert.Root>
					{/if}
				{/if}
			</section>

			<Separator />

			<!-- 2. Caption, editable right up to posting -->
			<section class="flex flex-col gap-1.5">
				<Label for="tiktok-title">Caption</Label>
				<Textarea
					id="tiktok-title"
					bind:value={title}
					rows={3}
					placeholder="Write the caption for this post"
				/>
			</section>

			<!-- 3. Audience, with no default -->
			<section class="flex flex-col gap-1.5">
				<Label for="tiktok-privacy">Who can see this post</Label>
				<!--
					No default. Only levels TikTok currently offers this account are
					listed, and the server re-checks against a live read.
				-->
				<select
					id="tiktok-privacy"
					bind:value={privacyLevel}
					class="h-9 rounded-md border bg-background px-3 text-sm"
				>
					<option value="">Select who can see this post…</option>
					{#each creatorInfo.privacyLevelOptions as level (level)}
						<option
							value={level}
							disabled={level === 'SELF_ONLY' && brandedSelected}
						>
							{PRIVACY_LABELS[level]}{level === 'SELF_ONLY' && brandedSelected
								? ' (not available for branded content)'
								: ''}
						</option>
					{/each}
				</select>
			</section>

			<!--
				4. Opt-IN interaction controls, all unchecked by default. One the
				account switched off account-wide is greyed out, because a single post
				cannot switch it back on.
			-->
			<section class="flex flex-col gap-2">
				<span class="text-sm font-medium">Allow people to</span>
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
			</section>

			<!--
				5. ONE commercial disclosure toggle, off by default. The two kinds
				appear only once it is on.
			-->
			<section class="flex flex-col gap-2 rounded-md border p-3">
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
								Branded content cannot be private. Choose a different audience,
								or turn off Branded content.
							</p>
						{/if}
					</div>
				{/if}
			</section>

			<!-- 6. A separate, permanent claim about how the content was made -->
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

			<!--
				7. The declaration this exact configuration requires. It changes with
				the commercial disclosure, so it is derived rather than fixed.
			-->
			<p class="text-xs text-muted-foreground">{declaration}</p>

			{#if blockers.length > 0}
				<ul class="flex flex-col gap-1 text-xs text-muted-foreground">
					{#each blockers as blocker (blocker)}
						<li>{blocker}</li>
					{/each}
				</ul>
			{/if}

			<div class="flex flex-col gap-2">
				<Button
					class="self-start"
					disabled={posting || blockers.length > 0}
					onclick={confirmPost}
				>
					{posting ? 'Sending to TikTok…' : 'Post to TikTok'}
				</Button>
				<p class="text-xs text-muted-foreground">
					TikTok processes and reviews posts after they are sent, which can take
					a few minutes before the post appears on the profile. Epicenter follows
					this post and shows the result below.
				</p>
			</div>
		{/if}
	</Card.Content>
</Card.Root>

<!--
	The DURABLE block. Read from the recorded attempt rather than from the last
	submit, so it survives a reload, an account switch, and a closed tab: the fact
	that TikTok may be holding a post lives in Postgres, not in a variable.

	No "try again" affordance anywhere in it. When the attempt has no publish id
	the only honest remedy is the creator looking at TikTok, so that is the only
	thing offered.
-->
{#if blockingAttempt}
	{@const described = describeAttemptStatus(blockingAttempt.status)}
	<Alert.Root variant="destructive">
		<CircleAlertIcon class="size-4" />
		<Alert.Description class="space-y-2">
			<p class="font-medium">{described.label}</p>
			<p>{described.detail}</p>
			{#if submitNotice}
				<p class="text-xs">{submitNotice}</p>
			{/if}
			{#if blockingAttempt.publishId}
				<p class="text-xs break-all">
					TikTok task id: {blockingAttempt.publishId}
				</p>
			{/if}
			<p class="text-xs">
				Posting to this account is paused until this is settled, so one post
				cannot become two.
			</p>

			{#if blockingPhase === 'active'}
				<!--
					Still in flight. No remedy is offered on purpose: the request that owns
					this attempt may be uploading right now, and letting anyone declare an
					outcome for it is the race the lease exists to prevent.
				-->
				<p class="flex items-center gap-2 text-xs">
					<Spinner class="size-3.5" />
					Still sending. Epicenter will record the outcome when TikTok answers.
				</p>
			{:else if requiresManualResolution(blockingAttempt, now)}
				<!--
					There is no publish id, so nothing can be polled and only the creator
					can close this out. Both answers are offered plainly, because guessing
					on their behalf is exactly what the invariant forbids.
				-->
				<div class="flex flex-wrap items-center gap-2 pt-1">
					<Button
						variant="outline"
						size="sm"
						disabled={resolving === blockingAttempt.id}
						onclick={() =>
							blockingAttempt &&
							confirmResolution(blockingAttempt.id, 'RESOLVED_POSTED')}
					>
						It is on the profile
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={resolving === blockingAttempt.id}
						onclick={() =>
							blockingAttempt &&
							confirmResolution(blockingAttempt.id, 'RESOLVED_NOT_POSTED')}
					>
						Nothing was posted
					</Button>
				</div>
			{:else}
				<Button
					variant="outline"
					size="sm"
					class="mt-1"
					disabled={following}
					onclick={() =>
						blockingAttempt?.publishId && follow(blockingAttempt.publishId)}
				>
					<RefreshCwIcon class="size-3.5" />
					Check its status
				</Button>
			{/if}
		</Alert.Description>
	</Alert.Root>
{/if}

<!-- The post being followed, from init through to TikTok's own terminal status -->
<!--
	Suppressed when the followed attempt IS the blocking one: the alert above is
	already saying this, with the remedy attached, and repeating the same status in
	two cards reads as two different posts.
-->
{#if outcome && outcomeStatus && tracked?.id !== blockingAttempt?.id}
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-base">This post</Card.Title>
			{#if outcome.sentAt}
				<Card.Description>Sent {formatTime(outcome.sentAt)}</Card.Description>
			{/if}
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<div class="flex items-center gap-2">
				{#if following}
					<Spinner class="size-4" />
				{/if}
				<span class="text-sm font-medium {TONE_CLASS[outcomeStatus.tone]}">
					{outcomeStatus.label}
				</span>
			</div>
			<p class="text-xs text-muted-foreground">{outcomeStatus.detail}</p>

			{#if outcome.failReason}
				<p class="text-xs text-destructive break-all">
					TikTok's reason: {outcome.failReason}
				</p>
			{/if}

			{#if outcome.publicPostIds.length > 0}
				<!--
					The only fact that proves a PUBLIC delivery: TikTok reported a public
					post id for this task.

					Shown as the exact id and nothing else. There used to be a link here,
					built by assembling TikTok's canonical video URL out of the creator's
					handle and this id. TikTok documents no permalink builder and returns
					no URL from this endpoint, so that link was Epicenter's guess wearing
					the provider's authority: right up until the URL shape changes, and
					then a confident dead link on the one screen whose whole job is
					telling the truth about what happened.
				-->
				<div class="flex flex-col gap-1">
					{#each outcome.publicPostIds as postId (postId)}
						<span class="text-sm break-all">TikTok post id: {postId}</span>
					{/each}
					<span class="text-xs text-muted-foreground">
						Open the TikTok app to see the post itself.
					</span>
				</div>
			{:else if outcome.status === 'PUBLISH_COMPLETE'}
				<p class="text-xs text-muted-foreground">
					TikTok reported no public post id, which is what a private post or one
					still in review looks like. Open the TikTok app to see it.
				</p>
			{/if}

			{#if followGaveUp}
				<p class="text-xs text-muted-foreground">
					Epicenter stopped checking automatically after 10 minutes. TikTok may
					still be reviewing this post.
				</p>
			{/if}
			{#if followError}
				<p class="text-xs text-destructive">
					Could not read the status: {followError}. This says nothing about the
					post itself.
				</p>
			{/if}
			{#if !outcome.recorded}
				<p class="text-xs text-destructive">
					Epicenter could not save this outcome, so it may not appear here after
					a reload. The TikTok post id above is the only handle on it.
				</p>
			{/if}

			{#if !following}
				<Button variant="outline" size="sm" class="self-start" onclick={checkNow}>
					<RefreshCwIcon class="size-3.5" />
					Check status
				</Button>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}

<!--
	Earlier posts sent from Epicenter. Deliberately NOT the account's TikTok feed:
	this is Epicenter's own record of what it was asked to publish, which is what
	makes an interrupted post recoverable after a reload.
-->
{#if earlierAttempts.length > 0}
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-base">Earlier posts from Epicenter</Card.Title>
		</Card.Header>
		<Card.Content>
			<ul class="flex flex-col divide-y">
				{#each earlierAttempts as attempt (attempt.id)}
					{@const described = describeAttemptStatus(attempt.status)}
					<li class="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
						<div class="flex items-baseline justify-between gap-2">
							<span class="text-sm {TONE_CLASS[described.tone]}">
								{described.label}
							</span>
							<span class="text-xs text-muted-foreground">
								{formatTime(attempt.createdAt)}
							</span>
						</div>
						{#if attempt.publicPostIds && attempt.publicPostIds.length > 0}
							<span class="text-xs text-muted-foreground break-all">
								TikTok post id: {attempt.publicPostIds.join(', ')}
							</span>
						{:else if canReadRemoteStatus(attempt)}
							<button
								type="button"
								class="self-start text-xs underline"
								onclick={() => attempt.publishId && follow(attempt.publishId)}
							>
								Check this post's status
							</button>
						{/if}
						{#if attempt.failReason}
							<span class="text-xs text-destructive break-all">
								{attempt.failReason}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>
{/if}
