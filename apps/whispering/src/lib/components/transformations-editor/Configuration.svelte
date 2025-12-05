<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import {
		AnthropicApiKeyInput,
		CustomEndpointInput,
		GoogleApiKeyInput,
		GroqApiKeyInput,
		OpenAiApiKeyInput,
		OpenRouterApiKeyInput,
	} from '$lib/components/settings';
	import * as Accordion from '@epicenter/ui/accordion';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Select from '@epicenter/ui/select';
	import { Separator } from '@epicenter/ui/separator';
	import { Switch } from '@epicenter/ui/switch';
	import { Textarea } from '@epicenter/ui/textarea';
	import { TRANSFORMATION_STEP_TYPE_OPTIONS } from '$lib/constants/database';
	import {
		ANTHROPIC_INFERENCE_MODEL_OPTIONS,
		GOOGLE_INFERENCE_MODEL_OPTIONS,
		GROQ_INFERENCE_MODEL_OPTIONS,
		INFERENCE_PROVIDER_OPTIONS,
		OPENAI_INFERENCE_MODEL_OPTIONS,
	} from '$lib/constants/inference';
	import type { Transformation } from '$lib/services/db';
	import { generateDefaultTransformationStep } from '$lib/services/db';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { slide } from 'svelte/transition';

	// Derived labels for select triggers
	const stepTypeLabel = (type: string) =>
		TRANSFORMATION_STEP_TYPE_OPTIONS.find((o) => o.value === type)?.label;
	const providerLabel = (provider: string) =>
		INFERENCE_PROVIDER_OPTIONS.find((o) => o.value === provider)?.label;
	const openaiModelLabel = (model: string) =>
		OPENAI_INFERENCE_MODEL_OPTIONS.find((o) => o.value === model)?.label;
	const groqModelLabel = (model: string) =>
		GROQ_INFERENCE_MODEL_OPTIONS.find((o) => o.value === model)?.label;
	const anthropicModelLabel = (model: string) =>
		ANTHROPIC_INFERENCE_MODEL_OPTIONS.find((o) => o.value === model)?.label;
	const googleModelLabel = (model: string) =>
		GOOGLE_INFERENCE_MODEL_OPTIONS.find((o) => o.value === model)?.label;

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
		<Field.Field>
			<Field.Label for="title">Title</Field.Label>
			<Input
				id="title"
				value={transformation.title}
				oninput={(e) => {
					transformation = {
						...transformation,
						title: e.currentTarget.value,
					};
				}}
				placeholder="e.g., Format Meeting Notes"
			/>
			<Field.Description>
				A clear, concise name that describes what this transformation does
			</Field.Description>
		</Field.Field>
		<Field.Field>
			<Field.Label for="description">Description</Field.Label>
			<Textarea
				id="description"
				value={transformation.description}
				oninput={(e) => {
					transformation = {
						...transformation,
						description: e.currentTarget.value,
					};
				}}
				placeholder="e.g., Converts meeting transcripts into bullet points and highlights action items"
			/>
			<Field.Description>
				Describe what this transformation does, its purpose, and how it will be
				used
			</Field.Description>
		</Field.Field>
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
								<Select.Root
									type="single"
									bind:value={
										() => step.type,
										(value) => {
											if (value) {
												transformation = {
													...transformation,
													steps: transformation.steps.map((s, i) =>
														i === index ? { ...s, type: value } : s,
													),
												};
											}
										}
									}
								>
									<Select.Trigger id="step-type" class="h-8">
										{stepTypeLabel(step.type) ?? 'Select a step type'}
									</Select.Trigger>
									<Select.Content>
										{#each TRANSFORMATION_STEP_TYPE_OPTIONS as item}
											<Select.Item value={item.value} label={item.label} />
										{/each}
									</Select.Content>
								</Select.Root>
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
									<Field.Field>
										<Field.Label for="find_replace.findText">Find Text</Field.Label>
										<Input
											id="find_replace.findText"
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
									</Field.Field>
									<Field.Field>
										<Field.Label for="find_replace.replaceText">Replace Text</Field.Label>
										<Input
											id="find_replace.replaceText"
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
									</Field.Field>
								</div>
								<Accordion.Root type="single" class="w-full">
									<Accordion.Item class="border-none" value="advanced">
										<Accordion.Trigger class="text-sm">
											Advanced Options
										</Accordion.Trigger>
										<Accordion.Content>
											<Field.Field orientation="horizontal">
												<Switch
													id="find_replace.useRegex"
													checked={step['find_replace.useRegex']}
													onCheckedChange={(v) => {
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
													}}
												/>
												<Field.Content>
													<Field.Label for="find_replace.useRegex">Use Regex</Field.Label>
													<Field.Description>
														Enable advanced pattern matching using regular expressions
														(for power users)
													</Field.Description>
												</Field.Content>
											</Field.Field>
										</Accordion.Content>
									</Accordion.Item>
								</Accordion.Root>
							</div>
						{:else if step.type === 'prompt_transform'}
							<div class="space-y-6">
								<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
									<Field.Field>
										<Field.Label for="prompt_transform.inference.provider">Provider</Field.Label>
										<Select.Root
											type="single"
											bind:value={
												() => step['prompt_transform.inference.provider'],
												(value) => {
													if (value) {
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
											}
										>
											<Select.Trigger id="prompt_transform.inference.provider" class="w-full">
												{providerLabel(step['prompt_transform.inference.provider']) ?? 'Select a provider'}
											</Select.Trigger>
											<Select.Content>
												{#each INFERENCE_PROVIDER_OPTIONS as item}
													<Select.Item value={item.value} label={item.label} />
												{/each}
											</Select.Content>
										</Select.Root>
									</Field.Field>

									{#if step['prompt_transform.inference.provider'] === 'OpenAI'}
										<Field.Field>
											<Field.Label for="prompt_transform.inference.provider.OpenAI.model">Model</Field.Label>
											<Select.Root
												type="single"
												bind:value={
													() =>
														step[
															'prompt_transform.inference.provider.OpenAI.model'
														],
													(value) => {
														if (value) {
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
												}
											>
												<Select.Trigger id="prompt_transform.inference.provider.OpenAI.model" class="w-full">
													{openaiModelLabel(step['prompt_transform.inference.provider.OpenAI.model']) ?? 'Select a model'}
												</Select.Trigger>
												<Select.Content>
													{#each OPENAI_INFERENCE_MODEL_OPTIONS as item}
														<Select.Item value={item.value} label={item.label} />
													{/each}
												</Select.Content>
											</Select.Root>
										</Field.Field>
									{:else if step['prompt_transform.inference.provider'] === 'Groq'}
										<Field.Field>
											<Field.Label for="prompt_transform.inference.provider.Groq.model">Model</Field.Label>
											<Select.Root
												type="single"
												bind:value={
													() =>
														step[
															'prompt_transform.inference.provider.Groq.model'
														],
													(value) => {
														if (value) {
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
												}
											>
												<Select.Trigger id="prompt_transform.inference.provider.Groq.model" class="w-full">
													{groqModelLabel(step['prompt_transform.inference.provider.Groq.model']) ?? 'Select a model'}
												</Select.Trigger>
												<Select.Content>
													{#each GROQ_INFERENCE_MODEL_OPTIONS as item}
														<Select.Item value={item.value} label={item.label} />
													{/each}
												</Select.Content>
											</Select.Root>
										</Field.Field>
									{:else if step['prompt_transform.inference.provider'] === 'Anthropic'}
										<Field.Field>
											<Field.Label for="prompt_transform.inference.provider.Anthropic.model">Model</Field.Label>
											<Select.Root
												type="single"
												bind:value={
													() =>
														step[
															'prompt_transform.inference.provider.Anthropic.model'
														],
													(value) => {
														if (value) {
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
												}
											>
												<Select.Trigger id="prompt_transform.inference.provider.Anthropic.model" class="w-full">
													{anthropicModelLabel(step['prompt_transform.inference.provider.Anthropic.model']) ?? 'Select a model'}
												</Select.Trigger>
												<Select.Content>
													{#each ANTHROPIC_INFERENCE_MODEL_OPTIONS as item}
														<Select.Item value={item.value} label={item.label} />
													{/each}
												</Select.Content>
											</Select.Root>
										</Field.Field>
									{:else if step['prompt_transform.inference.provider'] === 'Google'}
										<Field.Field>
											<Field.Label for="prompt_transform.inference.provider.Google.model">Model</Field.Label>
											<Select.Root
												type="single"
												bind:value={
													() =>
														step[
															'prompt_transform.inference.provider.Google.model'
														],
													(value) => {
														if (value) {
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
												}
											>
												<Select.Trigger id="prompt_transform.inference.provider.Google.model" class="w-full">
													{googleModelLabel(step['prompt_transform.inference.provider.Google.model']) ?? 'Select a model'}
												</Select.Trigger>
												<Select.Content>
													{#each GOOGLE_INFERENCE_MODEL_OPTIONS as item}
														<Select.Item value={item.value} label={item.label} />
													{/each}
												</Select.Content>
											</Select.Root>
										</Field.Field>
									{:else if step['prompt_transform.inference.provider'] === 'OpenRouter'}
										<Field.Field>
											<Field.Label for="prompt_transform.inference.provider.OpenRouter.model">Model</Field.Label>
											<Input
												id="prompt_transform.inference.provider.OpenRouter.model"
												value={step[
													'prompt_transform.inference.provider.OpenRouter.model'
												]}
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
										</Field.Field>
									{:else if step['prompt_transform.inference.provider'] === 'Custom'}
										<div class="space-y-4">
											<Field.Field>
												<Field.Label for="prompt_transform.inference.provider.Custom.baseUrl">API Base URL</Field.Label>
												<Input
													id="prompt_transform.inference.provider.Custom.baseUrl"
													value={step[
														'prompt_transform.inference.provider.Custom.baseUrl'
													]}
													oninput={(e) => {
														transformation = {
															...transformation,
															steps: transformation.steps.map((s, i) =>
																i === index
																	? {
																			...s,
																			'prompt_transform.inference.provider.Custom.baseUrl':
																				e.currentTarget.value,
																		}
																	: s,
															),
														};
													}}
													placeholder="http://localhost:11434/v1"
												/>
												<Field.Description>
													Overrides the default URL from Settings. Useful when
													this step needs a different local model server.
												</Field.Description>
											</Field.Field>
											<Field.Field>
												<Field.Label for="prompt_transform.inference.provider.Custom.model">Model</Field.Label>
												<Input
													id="prompt_transform.inference.provider.Custom.model"
													value={step[
														'prompt_transform.inference.provider.Custom.model'
													]}
													oninput={(e) => {
														transformation = {
															...transformation,
															steps: transformation.steps.map((s, i) =>
																i === index
																	? {
																			...s,
																			'prompt_transform.inference.provider.Custom.model':
																				e.currentTarget.value,
																		}
																	: s,
															),
														};
													}}
													placeholder="llama3.2"
												/>
												<Field.Description>
													Enter the exact model name as it appears in your local
													service (e.g., run <code class="bg-muted px-1 rounded">ollama list</code>).
												</Field.Description>
											</Field.Field>
										</div>
									{/if}
								</div>

								<Field.Field>
									<Field.Label for="prompt_transform.systemPromptTemplate">System Prompt Template</Field.Label>
									<Textarea
										id="prompt_transform.systemPromptTemplate"
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
								</Field.Field>
								<Field.Field>
									<Field.Label for="prompt_transform.userPromptTemplate">User Prompt Template</Field.Label>
									<Textarea
										id="prompt_transform.userPromptTemplate"
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
									/>
									{#if step['prompt_transform.userPromptTemplate'] && !step['prompt_transform.userPromptTemplate'].includes('{{input}}')}
										<Field.Description>
											<span class="text-amber-500 font-semibold">
												Remember to include {'{{input}}'} in your prompt - this is
												where your text will be inserted!
											</span>
										</Field.Description>
									{/if}
								</Field.Field>
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
											{:else if step['prompt_transform.inference.provider'] === 'Custom'}
												<CustomEndpointInput showBaseUrl={false} />
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
