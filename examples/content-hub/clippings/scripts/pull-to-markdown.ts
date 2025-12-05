import { createEpicenterClient } from '@epicenter/hq';
import epicenter from '../../epicenter.config';

await using client = await createEpicenterClient(epicenter);

await client.clippings.pullToMarkdown();

console.log('✓ Pulled to markdown');
