# @epicenter/skills

`@epicenter/skills` declares one inert Skills workspace contract and ordinary
services over an already opened handle. The package does not open storage,
construct browser or Node runtimes, expose Yjs GUIDs, or register actions.

```ts
import {
	listSkills,
	skillsWorkspace,
} from '@epicenter/skills';
import { createBunWorkspaceRuntime } from '@epicenter/workspace/sqlite/bun';

await using runtime = createBunWorkspaceRuntime({
	authorityKey: 'local-device',
	storageRoot: '/app/data',
});
const skills = await runtime.open(skillsWorkspace);
const catalog = await listSkills(skills);
```

## Data model

Skill and reference metadata are canonical JSON records interpreted by the
release-local table lenses. The runtime allocates structural row ids. A
SKILL.md `metadata.id` is stored separately as `sourceId`, so filesystem
round-trips can match records without forging canonical identity.

Instruction and reference bodies are top-level parameterized documents:

```ts
await using instructions = await skills.documents.instructions.open({
	skillId: skill.id,
});
instructions.content.write('# Instructions');
```

The runtime derives private room identity, persistence, and synchronization.
Callers pass only domain parameters.

Every catalog scan is bounded. Services return nonconforming rows explicitly;
they never heal user data during reads. A developer repairs a row with the same
typed `patch` used for ordinary writes.

## Filesystem portability

The `@epicenter/skills/node` subpath exports `importSkillsFromDisk` and
`exportSkillsToDisk`. Both receive an opened Skills handle. They do not create a
Node-specific workspace or own runtime lifecycle.

## License

AGPL-3.0
