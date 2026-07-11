import type { WhisperingDesktop } from '$lib/desktop/contract';
import type { WhisperingEnvironment } from '$lib/environment/contract';
import type { AccountRuntime, WhisperingWorkspace } from './contracts';

type Expect<T extends true> = T;
type Equal<TLeft, TRight> =
	(<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
		? true
		: false;
type NullishKeys<TValue> = {
	[TKey in keyof TValue]: Extract<TValue[TKey], null | undefined> extends never
		? never
		: TKey;
}[keyof TValue];

type _EnvironmentIsComplete = Expect<
	Equal<
		keyof WhisperingEnvironment,
		| 'auth'
		| 'artifacts'
		| 'captureSurfaces'
		| 'downloads'
		| 'delivery'
		| 'notifications'
		| 'playbackSuppression'
		| 'recording'
		| 'reveal'
		| 'supportsCompletion'
		| 'text'
		| 'transcription'
	>
>;
type _EnvironmentHasNoNullableCapabilities = Expect<
	Equal<NullishKeys<WhisperingEnvironment>, never>
>;

type _DesktopIsComplete = Expect<
	Equal<
		keyof WhisperingDesktop,
		| 'reveal'
		| 'shortcuts'
		| 'dictation'
		| 'localTranscription'
		| 'playbackSuppression'
		| 'delivery'
	>
>;
type _DesktopHasNoNullableCapabilities = Expect<
	Equal<NullishKeys<WhisperingDesktop>, never>
>;

type _WorkspaceIsAlwaysACompleteValue = Expect<
	Equal<Extract<WhisperingWorkspace, null | undefined>, never>
>;
type _AccountIsCompleteBelowItsGate = Expect<
	Equal<Extract<AccountRuntime, null | undefined>, never>
>;
type _SignedOutIsNotAnAccountSession = Expect<
	Equal<Extract<AccountRuntime['session'], { status: 'signed-out' }>, never>
>;
type _ReauthRequiredIsNotAnAccountSession = Expect<
	Equal<
		Extract<AccountRuntime['session'], { status: 'reauth-required' }>,
		never
	>
>;
