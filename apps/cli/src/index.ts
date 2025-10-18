#!/usr/bin/env bun
import { Log } from '@epicenter/opencode/util/log.ts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { ShCommand } from './commands/sh.js';

const cli = yargs(hideBin(process.argv))
	.scriptName('epicenter')
	.usage('$0 <command> [options]')
	.help('help', 'show help')
	.alias('help', 'h')
	.version('version', 'show version number')
	.alias('version', 'v')
	.option('print-logs', {
		describe: 'print logs to stderr',
		type: 'boolean',
	})
	.option('log-level', {
		describe: 'log level',
		type: 'string',
		choices: ['DEBUG', 'INFO', 'WARN', 'ERROR'],
	})
	.middleware(async (opts) => {
		await Log.init({
			print: process.argv.includes('--print-logs'),
			dev: process.env.NODE_ENV === 'development',
			level: (() => {
				if (opts.logLevel) return opts.logLevel as Log.Level;
				if (process.env.NODE_ENV === 'development') return 'DEBUG';
				return 'INFO';
			})(),
		});

		Log.Default.info('epicenter', {
			args: process.argv.slice(2),
		});
	})
	.demandCommand(1, 'You need to specify a command')
	.command(ShCommand)
	.example(
		'epicenter sh',
		'Start local server with cloudflare tunnel and open epicenter.sh in browser',
	)
	.example(
		'epicenter sh --port=8080',
		'Start server on specific port (defaults to auto-discovered available port)',
	)
	.example(
		'epicenter sh --tunnel=ngrok',
		'Use ngrok instead of cloudflare for tunneling',
	)
	.example(
		'epicenter sh --no-tunnel --no-open',
		'Start local server only, without tunnel or browser',
	)
	.example(
		'epicenter sh --cors-origins=http://localhost:3000',
		'Add additional CORS allowed origins',
	)
	.strict()
	.fail((msg, err, yargs) => {
		if (err) throw err;
		console.error('❌', msg);
		console.error();
		yargs.showHelp();
		process.exit(1);
	});

process.on('unhandledRejection', (e) => {
	Log.Default.error('rejection', {
		e: e instanceof Error ? e.message : e,
	});
});

process.on('uncaughtException', (e) => {
	Log.Default.error('exception', {
		e: e instanceof Error ? e.message : e,
	});
});

try {
	await cli.parse();
} catch (error) {
	Log.Default.error('fatal', {
		message: error instanceof Error ? error.message : String(error),
		name: error instanceof Error ? error.name : 'Unknown',
	});
	console.error('❌ Unexpected error:', error);
	if (!process.argv.includes('--print-logs')) {
		console.error(
			`Run with --print-logs for more details, or check log file at ${Log.file()}`,
		);
	}
	process.exit(1);
}
