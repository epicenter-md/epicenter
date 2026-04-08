// Direct imports and re-exports from organized services

// Cloud transcription services
import { DeepgramTranscriptionServiceLive } from './cloud/deepgram';
import { ElevenlabsTranscriptionServiceLive } from './cloud/elevenlabs';
import { GroqTranscriptionServiceLive } from './cloud/groq';
import { MistralTranscriptionServiceLive } from './cloud/mistral';
import { OpenaiTranscriptionServiceLive } from './cloud/openai';
// Local transcription services
import { MoonshineTranscriptionServiceLive } from './local/moonshine';
import { ParakeetTranscriptionServiceLive } from './local/parakeet';
import { WhisperCppTranscriptionServiceLive } from './local/whispercpp';

// Self-hosted transcription services
import { SpeachesTranscriptionServiceLive } from './self-hosted/speaches';

export {
	DeepgramTranscriptionServiceLive as deepgram,
	ElevenlabsTranscriptionServiceLive as elevenlabs,
	GroqTranscriptionServiceLive as groq,
	MistralTranscriptionServiceLive as mistral,
	MoonshineTranscriptionServiceLive as moonshine,
	OpenaiTranscriptionServiceLive as openai,
	ParakeetTranscriptionServiceLive as parakeet,
	SpeachesTranscriptionServiceLive as speaches,
	WhisperCppTranscriptionServiceLive as whispercpp,
};
