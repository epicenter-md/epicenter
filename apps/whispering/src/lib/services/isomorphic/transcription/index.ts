// Direct imports and re-exports from organized services

// Cloud transcription services
import { DeepgramTranscriptionServiceLive } from './cloud/deepgram';
import { ElevenlabsTranscriptionServiceLive } from './cloud/elevenlabs';
import { GroqTranscriptionServiceLive } from './cloud/groq';
import { MistralTranscriptionServiceLive } from './cloud/mistral';
import { OpenaiTranscriptionServiceLive } from './cloud/openai';
// Local transcription services
import { CanaryTranscriptionServiceLive } from './local/canary';
import { MoonshineTranscriptionServiceLive } from './local/moonshine';
import { ParakeetTranscriptionServiceLive } from './local/parakeet';
import { WhisperCppTranscriptionServiceLive } from './local/whispercpp';

// Self-hosted transcription services
import { SpeachesTranscriptionServiceLive } from './self-hosted/speaches';

export {
	WhisperCppTranscriptionServiceLive as whispercpp,
	ParakeetTranscriptionServiceLive as parakeet,
	CanaryTranscriptionServiceLive as canary,
	MoonshineTranscriptionServiceLive as moonshine,
	DeepgramTranscriptionServiceLive as deepgram,
	ElevenlabsTranscriptionServiceLive as elevenlabs,
	GroqTranscriptionServiceLive as groq,
	MistralTranscriptionServiceLive as mistral,
	OpenaiTranscriptionServiceLive as openai,
	SpeachesTranscriptionServiceLive as speaches,
};
