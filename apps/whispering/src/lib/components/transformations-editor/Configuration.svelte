<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import {
		LabeledInput,
		LabeledSelect,
		LabeledSwitch,
		LabeledTextarea,
	} from '$lib/components/labeled/index.js';
	import {
		AnthropicApiKeyInput,
		GoogleApiKeyInput,
		GroqApiKeyInput,
		OpenAiApiKeyInput,
		OpenRouterApiKeyInput,
	} from '$lib/components/settings';
	import * as Accordion from '@repo/ui/accordion';
	import * as Alert from '@repo/ui/alert';
	import { Button } from '@repo/ui/button';
	import * as Card from '@repo/ui/card';
	import * as SectionHeader from '@repo/ui/section-header';
	import { Separator } from '@repo/ui/separator';
	import {
		TRANSFORMATION_STEP_TYPES,
		TRANSFORMATION_STEP_TYPES_TO_LABELS,
	} from '$lib/constants/database';
	import {
		ANTHROPIC_INFERENCE_MODEL_OPTIONS,
		GOOGLE_INFERENCE_MODEL_OPTIONS,
		GROQ_INFERENCE_MODEL_OPTIONS,
		INFERENCE_PROVIDER_OPTIONS,
		OPENAI_INFERENCE_MODEL_OPTIONS,
	} from '$lib/constants/inference';
	import type { Transformation } from '$lib/services/db';
	import { generateDefaultTransformationStep } from '$lib/services/db';
	import { CopyIcon, PlusIcon, TrashIcon } from '@lucide/svelte';
	import { slide } from 'svelte/transition';

	let { transformation = $bindable() }: { transformation: Transformation } =
		$props();

	function addStep() {
		transformation = {
			...transformation,
			steps: [...transformation.steps, generateDefaultTransformationStep()],
		};
	}

	function removeStep(index: number) {
		transformation = {
			...transformation,
			steps: transformation.steps.filter((_, i) => i !== index),
		};
	}

	function duplicateStep(index: number) {
		const stepToDuplicate = transformation.steps[index];
		const duplicatedStep = { ...stepToDuplicate, id: crypto.randomUUID() };
		transformation = {
			...transformation,
			steps: [
				...transformation.steps.slice(0, index + 1),
				duplicatedStep,
				...transformation.steps.slice(index + 1),
			],
		};
	}
</script>

<div class="flex flex-col gap-6 overflow-y-auto h-full px-2">
	<SectionHeader.Root>
		<SectionHeader.Title>Configuration</SectionHeader.Title>
		<SectionHeader.Description>
			Configure the title, description, and steps for how your transformation
			will process your text
		</SectionHeader.Description>
	</SectionHeader.Root>

	<Separator />

	<section class="space-y-4">
		<LabeledInput
			id="title"
			label="Title"
			value={transformation.title}
			oninput={(e) => {
				transformation = {
					...transformation,
					title: e.currentTarget.value,
				};
			}}
			placeholder="e.g., Format Meeting Notes"
			description="A clear, concise name that describes what this transformation does"
		/>
		<LabeledTextarea
			id="description"
			label="Description"
			value={transformation.description}
			oninput={(e) => {
				transformation = {
					...transformation,
					description: e.currentTarget.value,
				};
			}}
			placeholder="e.g., Converts meeting transcripts into bullet points and highlights action items"
			description="Describe what this transformation does, its purpose, and how it will be used"
		/>
	</section>

	<Separator />

	<section class="space-y-6">
		<h3 class="font-medium">Processing Steps</h3>
		{#if transformation.steps.length === 0}
			<Alert.Root variant="warning">
				<Alert.Title>Add your first processing step</Alert.Title>
				<Alert.Description>
					Each step will process your transcribed text in sequence. Start by
					adding a step below to define how your text should be transformed.
				</Alert.Description>
			</Alert.Root>
		{/if}

		<div class="space-y-4">
			{#each transformation.steps as step, index (index)}
				<div
					class="bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm"
					transition:slide
				>
					<Card.Header class="space-y-4">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<Card.Title class="text-xl">
									Step {index + 1}:
								</Card.Title>
								<LabeledSelect
									id="step-type"
									label="Type"
									bind:selected={
										() => step.type,
										(value) => {
											transformation = {
												...transformation,
												steps: transformation.steps.map((s, i) =>
													i === index ? { ...s, type: value } : s,
												),
											};
										}
									}
									items={TRANSFORMATION_STEP_TYPES.map(
										(type) =>
											({
												value: type,
												label: TRANSFORMATION_STEP_TYPES_TO_LABELS[type],
											}) as const,
									)}
									hideLabel
									class="h-8"
									placeholder="Select a step type"
								/>
							</div>
							<div class="flex items-center gap-2">
								<WhisperingButton
									tooltipContent="Duplicate step"
									variant="ghost"
									size="icon"
									class="size-8"
									onclick={() => duplicateStep(index)}
								>
									<CopyIcon class="size-4" />
								</WhisperingButton>
								<WhisperingButton
									tooltipContent="Delete step"
									variant="ghost"
									size="icon"
									class="size-8"
									onclick={() => removeStep(index)}
								>
									<TrashIcon class="size-4" />
								</WhisperingButton>
							</div>
						</div>
						{#if step.type === 'prompt_transform'}
							<Card.Description>
								{index === 0
									? `Use '{{input}}' to refer to the original text`
									: `Use '{{input}}' to refer to the text from step ${index}`}
							</Card.Description>
						{/if}
					</Card.Header>
					<Card.Content>
						{#if step.type === 'find_replace'}
							<div class="space-y-6">
								<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
									<LabeledInput
										id="find_replace.findText"
										label="Find Text"
										value={step['find_replace.findText']}
										oninput={(e) => {
											transformation = {
												...transformation,
												steps: transformation.steps.map((s, i) =>
													i === index
														? {
																...s,
																'find_replace.findText': e.currentTarget.value,
															}
														: s,
												),
											};
										}}
										placeholder="Text or pattern to search for in the transcript"
									/>
									<LabeledInput
										id="find_replace.replaceText"
										label="Replace Text"
										value={step['find_replace.replaceText']}
										oninput={(e) => {
											transformation = {
												...transformation,
												steps: transformation.steps.map((s, i) =>
													i === index
														? {
																...s,
																'find_replace.replaceText':
																	e.currentTarget.value,
															}
														: s,
												),
											};
										}}
										placeholder="Text to use as the replacement"
									/>
								</div>
								<Accordion.Root type="single" class="w-full">
									<Accordion.Item class="border-none" value="advanced">
										<Accordion.Trigger class="text-sm">
											Advanced Options
										</Accordion.Trigger>
										<Accordion.Content>
											<LabeledSwitch
												id="find_replace.useRegex"
												label="Use Regex"
												bind:checked={
													() => step['find_replace.useRegex'],
													(v) => {
														transformation = {
															...transformation,
															steps: transformation.steps.map((s, i) =>
																i === index
																	? {
																			...s,
																			'find_replace.useRegex': v,
																		}
																	: s,
															),
														};
													}
												}
												description="Enable advanced pattern matching using regular expressions (for power users)"
											/>
										</Accordion.Content>
									</Accordion.Item>
								</Accordion.Root>
							</div>
						{:else if step.type === 'prompt_transform'}
							<div class="space-y-6">
								<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
									<LabeledSelect
										id="prompt_transform.inference.provider"
										label="Provider"
										items={INFERENCE_PROVIDER_OPTIONS}
										bind:selected={
											() => step['prompt_transform.inference.provider'],
											(value) => {
												transformation = {
													...transformation,
													steps: transformation.steps.map((s, i) =>
														i === index
															? {
																	...s,
																	'prompt_transform.inference.provider': value,
																}
															: s,
													),
												};
											}
										}
										placeholder="Select a provider"
									/>

									{#if step['prompt_transform.inference.provider'] === 'OpenAI'}
										<LabeledSelect
											id="prompt_transform.inference.provider.OpenAI.model"
											label="Model"
											items={OPENAI_INFERENCE_MODEL_OPTIONS}
											bind:selected={
												() => step['prompt_transform.inference.provider.OpenAI.model'],
												(value) => {
													transformation = {
														...transformation,
														steps: transformation.steps.map((s, i) =>
															i === index
																? {
																		...s,
																		'prompt_transform.inference.provider.OpenAI.model':
																			value,
																	}
																: s,
														),
													};
												}
											}
											placeholder="Select a model"
										/>
									{:else if step['prompt_transform.inference.provider'] === 'Groq'}
										<LabeledSelect
											id="prompt_transform.inference.provider.Groq.model"
											label="Model"
											items={GROQ_INFERENCE_MODEL_OPTIONS}
											bind:selected={
												() => step['prompt_transform.inference.provider.Groq.model'],
												(value) => {
													transformation = {
														...transformation,
														steps: transformation.steps.map((s, i) =>
															i === index
																? {
																		...s,
																		'prompt_transform.inference.provider.Groq.model':
																			value,
																	}
																: s,
														),
													};
												}
											}
											placeholder="Select a model"
										/>
									{:else if step['prompt_transform.inference.provider'] === 'Anthropic'}
										<LabeledSelect
											id="prompt_transform.inference.provider.Anthropic.model"
											label="Model"
											items={ANTHROPIC_INFERENCE_MODEL_OPTIONS}
											bind:selected={
												() => step['prompt_transform.inference.provider.Anthropic.model'],
												(value) => {
													transformation = {
														...transformation,
														steps: transformation.steps.map((s, i) =>
															i === index
																? {
																		...s,
																		'prompt_transform.inference.provider.Anthropic.model':
																			value,
																	}
																: s,
														),
													};
												}
											}
											placeholder="Select a model"
										/>
									{:else if step['prompt_transform.inference.provider'] === 'Google'}
										<LabeledSelect
											id="prompt_transform.inference.provider.Google.model"
											label="Model"
											items={GOOGLE_INFERENCE_MODEL_OPTIONS}
											bind:selected={
												() => step['prompt_transform.inference.provider.Google.model'],
												(value) => {
													transformation = {
														...transformation,
														steps: transformation.steps.map((s, i) =>
															i === index
																? {
																		...s,
																		'prompt_transform.inference.provider.Google.model':
																			value,
																	}
																: s,
														),
													};
												}
											}
											placeholder="Select a model"
										/>
									{:else if step['prompt_transform.inference.provider'] === 'OpenRouter'}
										<LabeledInput
											id="prompt_transform.inference.provider.OpenRouter.model"
											label="Model"
											value={step['prompt_transform.inference.provider.OpenRouter.model']}
											oninput={(e) => {
												transformation = {
													...transformation,
													steps: transformation.steps.map((s, i) =>
														i === index
															? {
																	...s,
																	'prompt_transform.inference.provider.OpenRouter.model':
																		e.currentTarget.value,
																}
															: s,
													),
												};
											}}
											placeholder="Enter model name"
										/>
									{/if}
								</div>

								<LabeledTextarea
									id="prompt_transform.systemPromptTemplate"
									label="System Prompt Template"
									value={step['prompt_transform.systemPromptTemplate']}
									oninput={(e) => {
										transformation = {
											...transformation,
											steps: transformation.steps.map((s, i) =>
												i === index
													? {
															...s,
															'prompt_transform.systemPromptTemplate':
																e.currentTarget.value,
														}
													: s,
											),
										};
									}}
									placeholder="Define the AI's role and expertise, e.g., 'You are an expert at formatting meeting notes. Structure the text into clear sections with bullet points.'"
								/>
								<LabeledTextarea
									id="prompt_transform.userPromptTemplate"
									label="User Prompt Template"
									value={step['prompt_transform.userPromptTemplate']}
									oninput={(e) => {
										transformation = {
											...transformation,
											steps: transformation.steps.map((s, i) =>
												i === index
													? {
															...s,
															'prompt_transform.userPromptTemplate':
																e.currentTarget.value,
														}
													: s,
											),
										};
									}}
									placeholder="Tell the AI what to do with your text. Use {'{{input}}'} where you want your text to appear, e.g., 'Format this transcript into clear sections: {'{{input}}'}'"
								>
									{#snippet description()}
										{#if step['prompt_transform.userPromptTemplate'] && !step['prompt_transform.userPromptTemplate'].includes('{{input}}')}
											<p class="text-amber-500 text-sm font-semibold">
												Remember to include {'{{input}}'} in your prompt - this is
												where your text will be inserted!
											</p>
										{/if}
									{/snippet}
								</LabeledTextarea>
								<Accordion.Root type="single" class="w-full">
									<Accordion.Item class="border-none" value="advanced">
										<Accordion.Trigger class="text-sm">
											Advanced Options
										</Accordion.Trigger>
										<Accordion.Content>
											{#if step['prompt_transform.inference.provider'] === 'OpenAI'}
												<OpenAiApiKeyInput />
											{:else if step['prompt_transform.inference.provider'] === 'Groq'}
												<GroqApiKeyInput />
											{:else if step['prompt_transform.inference.provider'] === 'Anthropic'}
												<AnthropicApiKeyInput />
											{:else if step['prompt_transform.inference.provider'] === 'Google'}
												<GoogleApiKeyInput />
											{:else if step['prompt_transform.inference.provider'] === 'OpenRouter'}
												<OpenRouterApiKeyInput />
											{/if}
										</Accordion.Content>
									</Accordion.Item>
								</Accordion.Root>
							</div>
						{/if}
					</Card.Content>
				</div>
			{/each}
		</div>

		<Button
			onclick={addStep}
			variant={transformation.steps.length === 0 ? 'default' : 'outline'}
			class="w-full"
		>
			<PlusIcon class="mr-2 size-4" />
			{transformation.steps.length === 0
				? 'Add Your First Step'
				: 'Add Another Step'}
		</Button>
	</section>
</div>
