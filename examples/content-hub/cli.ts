import { createCLI } from '@epicenter/hq/cli';
import { hideBin } from 'yargs/helpers';
import config from './epicenter.config';

// Create and run CLI (parsing happens inside createCLI)
await createCLI({ config, argv: hideBin(process.argv) });
