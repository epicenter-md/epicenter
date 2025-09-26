import type { WhisperingSoundNames } from '$lib/constants/sounds';

export interface CustomSound {
	id: WhisperingSoundNames;
	serializedAudio: { arrayBuffer: ArrayBuffer; blobType: string };
	fileName: string;
	fileSize: number;
	uploadedAt: string;
	updatedAt: string;
}

export interface CustomSoundUpload {
	file: File;
	soundKey: WhisperingSoundNames;
}

export interface CustomSoundMetadata {
	fileName: string;
	fileSize: number;
	blobType: string;
	uploadedAt: string;
}
