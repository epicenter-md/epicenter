import { createEpicenterClient } from '@epicenter/hq';
import epicenter from '../../epicenter.config';

await using client = await createEpicenterClient(epicenter);

// Add articles in parallel since they're independent
await Promise.all([
	client.clippings.addFromUrl({
		url: 'https://blog.puzzmo.com/posts/2025/07/30/six-weeks-of-claude-code/',
	}),
	client.clippings.addFromUrl({
		url: 'https://zhengdongwang.com/2025/07/10/superhuman-ai-in-a-normal-age.html',
	}),
	client.clippings.addFromUrl({
		url: 'https://jaredheyman.medium.com/on-the-new-y-combinator-3c28e548896c',
	}),
]);

// Dedupe after all adds complete
client.clippings.removeDuplicates();

console.log('✓ Articles added');
