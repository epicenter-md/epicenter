import { Ok } from 'wellcrafted/result';
import { fromTaggedErr } from '$lib/result';
import * as services from '$lib/services';
import { defineQuery } from './_client';

export const ffmpeg = {
	checkFfmpegInstalled: defineQuery({
		queryKey: ['ffmpeg.checkInstalled'],
		resultQueryFn: async () => {
			const { data, error } = await services.ffmpeg.checkInstalled();
			if (error) {
				return fromTaggedErr(error, {
					title: '❌ Error checking FFmpeg installation',
				});
			}
			return Ok(data);
		},
	}),
};
