import { rpc } from '$lib/query';

export const load = async () => {
	const { data: ffmpegInstalled } =
		await rpc.ffmpeg.checkFfmpegInstalled.ensure();

	return {
		ffmpegInstalled: ffmpegInstalled === true,
	};
};
