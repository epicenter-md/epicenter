// Direct imports and re-exports from organized services

// Cloud transcription services
import { DeepgramTranscriptionServiceLive } from './cloud/deepgram';
import { ElevenlabsTranscriptionServiceLive } from './cloud/elevenlabs';
import { GroqTranscriptionServiceLive } from './cloud/groq';
import { MistralTranscriptionServiceLive } from './cloud/mistral';
import { OpenaiTranscriptionServiceLive } from './cloud/openai';
import { ParakeetTranscriptionServiceLive } from './local/parakeet';
// Local transcription services
import { WhisperCppTranscriptionServiceLive } from './local/whispercpp';

// Self-hosted transcription services
import { SpeachesTranscriptionServiceLive } from './self-hosted/speaches';

export {
	WhisperCppTranscriptionServiceLive as whispercpp,
	ParakeetTranscriptionServiceLive as parakeet,
	DeepgramTranscriptionServiceLive as deepgram,
	ElevenlabsTranscriptionServiceLive as elevenlabs,
	GroqTranscriptionServiceLive as groq,
	MistralTranscriptionServiceLive as mistral,
	OpenaiTranscriptionServiceLive as openai,
	SpeachesTranscriptionServiceLive as speaches,
};
