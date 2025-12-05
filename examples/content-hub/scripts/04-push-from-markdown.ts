/**
 * Push from Markdown to Database
 *
 * Reads markdown files from the pages index directory and syncs them to the database.
 * This overwrites database content with what's in the markdown files.
 */

import { createEpicenterClient } from '@epicenter/hq';
import epicenterConfig from '../epicenter.config';

console.log('🔗 Connecting to pages workspace...');

await using client = await createEpicenterClient(epicenterConfig);

console.log('📥 Pushing from markdown to database...\n');

const result = await client.pages.pushFromMarkdown();

if (result.error) {
	console.error('❌ Error:', result.error);
	process.exit(1);
}

console.log('✅ Push from markdown complete');
