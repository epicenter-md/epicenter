# Super Chat direct command forms

State: Draft

## Product sentence

Super Chat is a local command surface for Epicenter apps. Chat can call Epicenter-native actions and external MCP tools with the right approval policy; the direct command palette is narrower and only gives first-class forms to Epicenter-native actions with field-shaped inputs.

## Decision

Do not build a universal JSON Schema form generator for v1.

A Super Chat direct command form uses an Epicenter-native form contract:

- the input schema is a flat object
- every object property is an `@epicenter/field`-recognized leaf schema
- nested objects are not formable in v1
- unions are not formable in v1, including nullable unions
- arrays are formable only when they are part of the field vocabulary, such as `tags` or `multiSelect`

The wire format is still JSON Schema. The app authors the schema with TypeBox and `field.*`; the future direct-command listing will classify the serialized schema with `recognize(...)` from `@epicenter/field` when it has a real caller.

## Tool surfaces

```text
Epicenter-native action
  chat: yes
  direct command palette: yes, when input is formable
  generated UI: Epicenter field form

External MCP tool
  chat: yes
  direct command palette: not in v1
  generated UI: none in v1
  later escape hatch: whole-body JSON editor validated against inputSchema
```

External MCP tools can still be powerful in chat. They should not force the native command palette to become a generic API console.

## Consent boundary

Direct submit means consent only for the exact visible payload.

For generated Epicenter forms, every submitted property must be visible as a field in the form. No hidden schema branches, no server-side enrichment, and no ambient approval that carries to another call.

If a future advanced JSON runner exists, the whole JSON body is the visible payload. That is a separate surface from the polished direct command form path.

## Future implementation hook

The first direct-command listing or palette slice should introduce a small Super Chat-local classifier:

```text
recognizeFormableActionInput(schema)
  -> FormableActionInput when the schema is a flat object of field leaves
  -> null when the schema is chat-callable but not direct-formable
```

That classifier should live with Super Chat, not `@epicenter/field` or `@epicenter/workspace`: field owns leaf recognition, workspace owns tool execution, and Super Chat owns the product policy that only flat field-shaped inputs get direct forms. Add the classifier in the same slice as its first production caller so it does not exist only for tests.

The renderer should consume the classified shape instead of re-deciding formability in Svelte components. The route or client model that lists direct commands should hide or mark non-formable tools before the palette renders them.

## Asymmetric win

Refusing universal generated forms deletes a large code family: nested object rendering, arbitrary arrays, JSON Schema composition keywords, schema refs, MCP metadata quirks, default injection rules, and consent ambiguity around hidden payloads.

The product loss is small for v1. External tools remain available through chat, and a raw JSON runner can be added later without changing the polished Epicenter-native form contract.
