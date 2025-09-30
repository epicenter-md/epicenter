// Direct imports and re-exports from organized services

// Local transcription services
import { WhisperCppTranscriptionServiceLive } from './local/whispercpp';
import { ParakeetTranscriptionServiceLive } from './local/parakeet';

// Cloud transcription services
import { DeepgramTranscriptionServiceLive } from './cloud/deepgram';
import { ElevenlabsTranscriptionServiceLive } from './cloud/elevenlabs';
import { GroqTranscriptionServiceLive } from './cloud/groq';
import { OpenaiTranscriptionServiceLive } from './cloud/openai';

// Self-hosted transcription services
import { SpeachesTranscriptionServiceLive } from './self-hosted/speaches';

export {
	WhisperCppTranscriptionServiceLive as whispercpp,
	ParakeetTranscriptionServiceLive as parakeet,
	DeepgramTranscriptionServiceLive as deepgram,
	ElevenlabsTranscriptionServiceLive as elevenlabs,
	GroqTranscriptionServiceLive as groq,
	OpenaiTranscriptionServiceLive as openai,
	SpeachesTranscriptionServiceLive as speaches,
};
