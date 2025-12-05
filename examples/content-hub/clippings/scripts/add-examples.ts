import { createEpicenterClient } from '@epicenter/hq';
import epicenter from '../../epicenter.config';

await using client = await createEpicenterClient(epicenter);

// Add GitHub repos and landing pages in parallel
await Promise.all([
	// GitHub repos
	client.clippings.addGitHubRepo({
		url: 'https://github.com/coder/ghostty-web',
		readme_quality: 'great',
		impact: 'decent',
		title: null,
		description: null,
		hacker_news_url: 'https://news.ycombinator.com/item?id=46110842',
	}),
	client.clippings.addGitHubRepo({
		url: 'https://github.com/calcom/cal.com',
		title: 'calcom/cal.com',
		description: 'Scheduling infrastructure for absolutely everyone.',
		readme_quality: 'great',
		impact: 'excellent',
	}),
	client.clippings.addGitHubRepo({
		url: 'https://github.com/dubinc/dub',
		title: 'dubinc/dub',
		description:
			'The modern link attribution platform. Loved by world-class marketing teams like Framer, Perplexity, Superhuman, Twilio, Buffer and more.',
		readme_quality: 'great',
		impact: 'excellent',
	}),

	// Landing pages
	client.clippings.addLandingPage({
		url: 'https://cal.com/',
		title: 'Cal.com | Open Scheduling Infrastructure',
		design_quality: 'excellent',
	}),
	client.clippings.addLandingPage({
		url: 'https://dub.co/',
		title: 'Dub - The Modern Link Attribution Platform',
		design_quality: 'excellent',
	}),
]);

// Dedupe after all adds
client.clippings.removeDuplicates();

console.log('✓ GitHub repos and landing pages added');
