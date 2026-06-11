> **Note:** The tab-manager command queue implementation described here was removed in `specs/20260311T230000-remove-commands-table-and-awareness.md`. The discriminated union pattern itself remains a valid approach for typed command queues over Y.Doc.

# One Table, Eight Commands, Zero JSON.parse

A Y.Doc table with a discriminated union on `action` gives you a fully typed command queue. Each command variant carries its own input fields and result shape. Flat key-value pairs on a Y.Map, no serialization layer.

```typescript
const commandBase = type({
	id: CommandId,
	deviceId: DeviceId,
	createdAt: 'number',
	_v: '1',
});

const Command = commandBase.merge(
	type.or(
		{
			action: "'closeTabs'",
			tabIds: 'string[]',
			'result?': type({ closedCount: 'number' }).or('undefined'),
		},
		{
			action: "'openTab'",
			url: 'string',
			'windowId?': 'string',
			'result?': type({ tabId: 'string' }).or('undefined'),
		},
		// ... 6 more variants
	),
);
```

`commandBase` holds the shared fields. `.merge()` distributes over the union. Each variant gets the base fields merged in automatically. Arktype auto-discriminates on `action`.

## switch Narrows Everything

The consumer switches on `cmd.action` and TypeScript narrows the entire type. Inputs and result shape together:

```typescript
switch (cmd.action) {
	case 'closeTabs':
		// cmd.tabIds: string[] ✓
		// cmd.url: type error ✗
		result = await executeCloseTabs(cmd.tabIds, deviceId);
		break;
	case 'openTab':
		// cmd.url: string ✓
		// cmd.tabIds: type error ✗
		result = await executeOpenTab(cmd.url, cmd.windowId);
		break;
}
```

No runtime parsing. No `JSON.parse(cmd.payload)`. The Y.Map stores `tabIds`, `url`, `windowId` as native keys. The discriminant does double duty: dispatch logic and type narrowing in one field.

## result? Presence Is Status

There's no `status` field. A command with no `result` is pending; one with a `result` is done. Expiry is derived: `createdAt + TTL < now && !result` means expired. Fewer fields, fewer states to synchronize.

## The Lifecycle

```
Server writes command    →  Y.Doc syncs to device
                             ↓
Device observes change   →  Filters: my device? No result? Within TTL?
                             ↓
Executes Chrome API      →  browser.tabs.remove(ids)
                             ↓
Writes result back       →  commands.set({ ...cmd, result: { closedCount: 5 } })
                             ↓
Server observes result   →  Promise resolves, returns to AI
```

The server's `waitForCommandResult` wraps this in a promise. It observes the table for the command ID, resolves when `result` appears, rejects on TTL timeout. One Y.Doc observation, one promise, no polling.

## Why This Over a Generic Queue

A generic queue stores commands as `{ type: string, payload: string }` and forces you to parse and validate on both ends. The discriminated union makes the table schema the contract. The producer can only write valid command shapes (arktype validates at the Y.Doc boundary), and the consumer gets narrowed types from a switch statement. The schema is the documentation.
