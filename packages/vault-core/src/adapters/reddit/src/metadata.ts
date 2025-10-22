import type { AdapterMetadata } from '@repo/vault-core';
import type * as schema from './schema';

export const metadata = {
	reddit_posts: {
		id: 'Reddit post id (base36)',
		permalink: 'Full permalink URL to the post',
		date: 'Timestamp (UTC). Coerced to Date from export string/epoch',
		ip: 'Recorded IP address associated with the post event, if present',
		subreddit: 'Subreddit name where the post was made (e.g. sveltejs)',
		gildings: 'Number of gildings on the post (integer)',
		title: 'Post title text',
		url: 'Post URL target if link post',
		body: 'Self-post body text if present',
	},
	reddit_comments: {
		id: 'Reddit comment id (base36)',
		permalink: 'Full permalink URL to the comment',
		date: 'Timestamp (UTC). Coerced to Date from export string/epoch',
		ip: 'Recorded IP address associated with the comment event, if present',
		subreddit: 'Subreddit name where the comment was made',
		gildings: 'Number of gildings on the comment (integer)',
		link: 'Permalink URL to the parent post of this comment (CSV “link” field)',
		parent:
			'CSV “parent” field; thing id of parent post or comment when present',
		body: 'Comment body text',
		media: 'Media info field from CSV when present',
	},
} satisfies AdapterMetadata<typeof schema>;
