import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
	buildClaudeCodeConsultInvocation,
	type ClaudeCodeConsultParams,
	createConsultDetails,
	formatClaudeCodeConsultResult,
	getConsultFailure,
	parseClaudeCodeJson,
	spawnClaudeCodeConsult,
} from './claude-code-consult.ts';

const ConsultParams = Type.Object({
	prompt: Type.String({
		description:
			'The exact consulting request for Claude Code. Include the decision, files, evidence, and expected artifact.',
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for Claude Code. Defaults to Pi's current working directory.",
		}),
	),
	session_id: Type.Optional(
		Type.String({
			description:
				'Claude Code session id to continue with --resume. Use the session_id from an earlier consult.',
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Optional Claude Code model override. Defaults to the user's Claude Code setting.",
		}),
	),
	effort: Type.Optional(
		Type.Union(
			[
				Type.Literal('low'),
				Type.Literal('medium'),
				Type.Literal('high'),
				Type.Literal('xhigh'),
				Type.Literal('max'),
			],
			{ description: 'Optional Claude Code effort override.' },
		),
	),
	max_budget_usd: Type.Optional(
		Type.Number({
			description:
				'Optional print-mode budget cap passed to Claude Code as --max-budget-usd.',
			minimum: 0,
		}),
	),
	allow_mcp: Type.Optional(
		Type.Boolean({
			description:
				'Allow Claude Code to inherit MCP configuration. Defaults to false, which strips MCP with --strict-mcp-config and denies mcp__* tools.',
			default: false,
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: 'claude_code_consult',
		label: 'Claude Code Consult',
		description: [
			'Ask local Claude Code for a high-value read-only consultation.',
			'Use this for architecture decisions, adversarial review, greenfield planning, ownership boundaries, and API tradeoffs.',
			'The tool runs Claude Code in plan mode and returns advice plus evidence, not final authority.',
		].join(' '),
		promptSnippet:
			'Consult local Claude Code in read-only plan mode for high-value architecture, review, and planning decisions.',
		promptGuidelines: [
			'Use claude_code_consult only when a high-cost second opinion is worth it: architecture, greenfield clean-break review, adversarial review, unclear ownership, API design, or complex implementation planning.',
			'Do not use claude_code_consult for search, grep, routine file reading, tests, small edits, straightforward refactors, or normal implementation.',
			'Treat claude_code_consult output as evidence to verify, not as final authority. Pi owns the coding session and execution.',
			'When calling claude_code_consult, give Claude exact paths, commands already run, open decisions, boundaries, and the artifact wanted.',
		],
		parameters: ConsultParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [
					{
						type: 'text',
						text: 'Consulting Claude Code in read-only plan mode...',
					},
				],
				details: { status: 'running' },
			});

			const invocation = buildClaudeCodeConsultInvocation(
				params as ClaudeCodeConsultParams,
				ctx.cwd,
			);
			let processResult;
			try {
				processResult = await spawnClaudeCodeConsult(invocation, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{ type: 'text', text: `Failed to start Claude Code: ${message}` },
					],
					details: {
						command: invocation.command,
						args: invocation.args,
						cwd: invocation.cwd,
						error: message,
					},
					isError: true,
				};
			}

			if (processResult.aborted) {
				return {
					content: [{ type: 'text', text: 'Claude Code consult was aborted.' }],
					details: {
						command: invocation.command,
						args: invocation.args,
						cwd: invocation.cwd,
					},
					isError: true,
				};
			}

			if (processResult.exitCode !== 0 && !processResult.stdout.trim()) {
				const details = createConsultDetails(invocation, processResult, {});
				return {
					content: [
						{
							type: 'text',
							text: getConsultFailure(details) ?? 'Claude Code consult failed.',
						},
					],
					details,
					isError: true,
				};
			}

			let raw;
			try {
				raw = parseClaudeCodeJson(processResult.stdout);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: 'text',
							text: [
								message,
								processResult.stderr.trim()
									? `stderr:\n${processResult.stderr.trim()}`
									: undefined,
							]
								.filter(Boolean)
								.join('\n\n'),
						},
					],
					details: {
						command: invocation.command,
						args: invocation.args,
						cwd: invocation.cwd,
						exitCode: processResult.exitCode,
						stderr: processResult.stderr,
						stdout: processResult.stdout,
					},
					isError: true,
				};
			}

			const details = createConsultDetails(invocation, processResult, raw);
			const failure = getConsultFailure(details);
			if (failure) {
				return {
					content: [{ type: 'text', text: failure }],
					details,
					isError: true,
				};
			}

			return {
				content: [
					{ type: 'text', text: formatClaudeCodeConsultResult(details) },
				],
				details,
			};
		},
	});
}
