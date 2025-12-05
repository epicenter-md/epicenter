import { createEpicenterClient } from '@epicenter/hq';
import epicenter from '../../epicenter.config';

await using client = await createEpicenterClient(epicenter);

// Add Paul Graham's "Founder Mode" essay
await client.clippings.addEssayFromUrl({
	url: 'https://paulgraham.com/foundermode.html',
	resonance: 'excellent',
});

console.log('✓ Essay added');
