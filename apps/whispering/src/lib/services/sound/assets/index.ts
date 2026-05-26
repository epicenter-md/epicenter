import type { WhisperingSoundNames } from '$lib/constants/sounds';
import {
	default as captureVadSoundSrc,
	default as stopManualSoundSrc,
} from './sound_ex_machina_Button_Blip.mp3';
import startManualSoundSrc from './zapsplat_household_alarm_clock_button_press_12967.mp3';
import stopVadSoundSrc from './zapsplat_household_alarm_clock_large_snooze_button_press_001_12968.mp3';
import startVadSoundSrc from './zapsplat_household_alarm_clock_large_snooze_button_press_002_12969.mp3';
import cancelSoundSrc from './zapsplat_multimedia_click_button_short_sharp_73510.mp3';
import transformationCompleteSoundSrc from './zapsplat_multimedia_notification_alert_ping_bright_chime_001_93276.mp3';
import transcriptionCompleteSoundSrc from './zapsplat_multimedia_ui_notification_classic_bell_synth_success_107505.mp3';

const soundSources = {
	'manual-start': startManualSoundSrc,
	'manual-cancel': cancelSoundSrc,
	'manual-stop': stopManualSoundSrc,
	'vad-start': startVadSoundSrc,
	'vad-capture': captureVadSoundSrc,
	'vad-stop': stopVadSoundSrc,
	transcriptionComplete: transcriptionCompleteSoundSrc,
	transformationComplete: transformationCompleteSoundSrc,
} satisfies Record<WhisperingSoundNames, string>;

/**
 * A single AudioContext is created on first use and kept alive for the app's
 * lifetime. This registers exactly one PipeWire node that persists across all
 * sound playback, allowing WirePlumber to reliably track and persist volume
 * adjustments. HTMLAudioElement creates a new PipeWire node per element, and
 * WebKit tears down/recreates the node on any src change, so WirePlumber
 * restores 1.0 (full volume) every time before user adjustments can be saved.
 */
let audioContext: AudioContext | null = null;
const bufferCache = new Map<WhisperingSoundNames, AudioBuffer>();

function getAudioContext(): AudioContext {
	if (audioContext === null) audioContext = new AudioContext();
	return audioContext;
}

async function getBuffer(
	soundName: WhisperingSoundNames,
): Promise<AudioBuffer> {
	const cached = bufferCache.get(soundName);
	if (cached !== undefined) return cached;

	const ctx = getAudioContext();
	const response = await fetch(soundSources[soundName]);
	const arrayBuffer = await response.arrayBuffer();
	const buffer = await ctx.decodeAudioData(arrayBuffer);
	bufferCache.set(soundName, buffer);
	return buffer;
}

/**
 * Play a sound effect through the shared AudioContext.
 *
 * Each call creates a lightweight BufferSourceNode (no PipeWire overhead)
 * connected to the context's destination. The source is automatically
 * cleaned up by the browser after playback ends.
 */
export async function playSound(
	soundName: WhisperingSoundNames,
): Promise<void> {
	const ctx = getAudioContext();
	if (ctx.state === 'suspended') await ctx.resume();

	const buffer = await getBuffer(soundName);
	const source = ctx.createBufferSource();
	source.buffer = buffer;
	source.connect(ctx.destination);
	source.start();
}
