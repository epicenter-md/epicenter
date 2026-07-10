import type { Result } from 'wellcrafted/result';
import type { Shortcuts } from '$lib/platform/types';
import type { TextError, WriteTextOutcome } from '$lib/services/text/types';

export type DesktopCapabilityError = {
	name: string;
	message: string;
};

export type RecordingOverlay = {
	show(): Promise<Result<void, DesktopCapabilityError>>;
	hide(): Promise<Result<void, DesktopCapabilityError>>;
};

export type Autostart = {
	isEnabled(): Promise<Result<boolean, DesktopCapabilityError>>;
	setEnabled(enabled: boolean): Promise<Result<void, DesktopCapabilityError>>;
};

export type WhisperingWindow = {
	show(): Promise<Result<void, DesktopCapabilityError>>;
	hide(): Promise<Result<void, DesktopCapabilityError>>;
};

export type CursorDelivery = {
	write(
		text: string,
		keepOnClipboard: boolean,
	): Promise<Result<WriteTextOutcome, TextError>>;
};

/** Complete product operations that exist only in an Epicenter build. */
export type WhisperingDesktop = {
	shortcuts: Shortcuts;
	overlay: RecordingOverlay;
	autostart: Autostart;
	window: WhisperingWindow;
	delivery: CursorDelivery;
};
