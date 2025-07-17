import { Ok, tryAsync } from 'wellcrafted/result';
// import { extension } from '@repo/extension';
import type { ClipboardService } from '.';
import { ClipboardServiceError } from './types';
// import { WhisperingErr } from '$lib/result';

export function createClipboardServiceWeb(): ClipboardService {
	return {
		setClipboardText: async (text) => {
			const { error: setClipboardError } = await tryAsync({
				try: () => navigator.clipboard.writeText(text),
				mapError: (error) =>
					ClipboardServiceError({
						message:
							'There was an error copying to the clipboard using the browser Clipboard API. Please try again.',
						context: { text },
						cause: error,
					}),
			});

			if (setClipboardError) {
				// const { error: extensionSetClipboardError } =
				// 	await extension.setClipboardText({
				// 		transcribedText: text,
				// 	});
				// if (extensionSetClipboardError) {
				// 	return extensionSetClipboardError.name ===
				// 		'ExtensionNotAvailableError'
				// 		? Err(setClipboardError)
				// 		: ClipboardServiceErr({
				// 				message:
				// 					'There was an error copying to the clipboard using the Whispering extension. Please try again.',
				// 				context: { text },
				// 				cause: extensionSetClipboardError,
				// 			});
				// }
				return Ok(undefined);
			}
			return Ok(undefined);
		},

		writeTextToCursor: async (text) => {
			// const { error: writeTextToCursorError } =
			// 	await extension.writeTextToCursor({
			// 		transcribedText: text,
			// 	});
			// if (writeTextToCursorError) {
			// 	if (writeTextToCursorError.name === 'ExtensionNotAvailableError') {
			// 		return WhisperingErr({
			// 			title: '⚠️ Extension Not Available',
			// 			description:
			// 				'The Whispering extension is not available. Please install it to enable writing transcribed text to the cursor.',
			// 			action: { type: 'more-details', error: writeTextToCursorError },
			// 			context: { text },
			// 			cause: writeTextToCursorError,
			// 		});
			// 	}
			// 	return ClipboardServiceErr({
			// 		message:
			// 			'There was an error writing transcribed text to the cursor using the Whispering extension. Please try again.',
			// 		context: { text },
			// 		cause: writeTextToCursorError,
			// 	});
			// }
			return Ok(undefined);
		},
	};
}
