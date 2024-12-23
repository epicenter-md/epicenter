import { Ok } from "./result";
import { createServiceErrorFns, type QueryFn } from "./services";

type WhisperingErrorProperties = { message: string };

const {
	Err: WhisperingErr,
	trySync: WhisperingTrySync,
	tryAsync: WhisperingTryAsync,
} = createServiceErrorFns<WhisperingErrorProperties>();

type WhisperService = {
	whisper: QueryFn<
		{ text: string },
		{ message: string },
		WhisperingErrorProperties
	>;
};

const whisper = (): WhisperService => {
	const x = "";
	return {
		whisper: async ({ text }) => {
			const result = WhisperingTrySync({
				try: () => x,
				catch: (error) => ({ message: "error" }),
			});
			if (!result.ok) {
				return result;
			}
			return Ok({ message: result.data });
		},
	};
};
