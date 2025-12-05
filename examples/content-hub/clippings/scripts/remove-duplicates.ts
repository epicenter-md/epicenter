import { createEpicenterClient } from '@epicenter/hq';
import epicenter from '../../epicenter.config';

await using client = await createEpicenterClient(epicenter);

const result = client.clippings.removeDuplicates();

if (result.error) {
	console.error('Error:', result.error);
} else {
	console.log(`✓ Removed ${result.data.deletedCount} duplicate(s)`);
}
