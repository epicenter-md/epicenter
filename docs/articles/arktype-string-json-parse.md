# That Time I Discovered Arktype's string.json.parse

I was building an auto-detect feature for ngrok URLs. You know the drill: fetch from an API, parse the JSON, validate the structure, extract what you need. The same dance we've done a thousand times.

Here's what I started with:

```typescript
const response = await fetch('http://localhost:4040/api/tunnels');
const data = await response.json();

// Now what? Hope it's the right shape?
if (data && data.tunnels && Array.isArray(data.tunnels)) {
  const httpsUrl = data.tunnels.find(t => t.proto === 'https')?.public_url;
  // ...
}
```

Every. Single. Time. Check if the property exists. Check if it's an array. Hope the nested properties are there. Cross your fingers that `proto` is actually a string.

## Here's the thing that took me too long to realize

I was treating JSON parsing and validation as two separate steps. Parse first, validate later. But they're not separate concerns. They're the same concern.

Then I found arktype's `string.json.parse`.

```typescript
import { type } from 'arktype';

// .to is a sugared .pipe for a single parsed output validator
const parseNgrokResponse = type("string.json.parse").to({
  tunnels: [{
    public_url: 'string',
    proto: '"http" | "https"'
  }]
});

// This is it. One line.
const parsed = parseNgrokResponse(responseText);
```

Wait, what just happened?

## The magic is in the .to() method

See, arktype's `.to()` is sugar for `.pipe()` that lets you chain transformations. When you use `type("string.json.parse").to({...})`, you're saying:
1. Take a string
2. Parse it as JSON
3. Validate the result against the schema
4. Return typed data or errors

One operation. Not three. The `.to()` method makes this even cleaner than before.

```typescript
const response = await fetch('http://localhost:4040/api/tunnels');
const text = await response.text();
const parsed = parseNgrokResponse(text);

if (parsed instanceof type.errors) {
  console.error('Invalid response:', parsed.summary);
  // You get actual, useful error messages
} else {
  // parsed is fully typed as { tunnels: Array<{ public_url: string, proto: "http" | "https" }> }
  const httpsUrl = parsed.tunnels.find(t => t.proto === 'https')?.public_url;
}
```

Notice what's missing? No manual JSON.parse(). No try/catch for malformed JSON. No runtime type checks. No TypeScript lies where you cast `as NgrokResponse` and hope for the best.

## But why is this better than Zod's .parse()?

Fair question. Here's what I mean:

```typescript
// Zod approach
const schema = z.object({
  tunnels: z.array(z.object({
    public_url: z.string(),
    proto: z.enum(['http', 'https'])
  }))
});

try {
  const data = JSON.parse(responseText);
  const validated = schema.parse(data);
} catch (e) {
  // Was it JSON parsing that failed? Validation? Who knows.
}

// Arktype approach
const parsed = parseNgrokResponse(responseText);
if (parsed instanceof type.errors) {
  // You know exactly what failed and where
}
```

The arktype version treats "string containing JSON that should match this shape" as a single type. Because that's what it is.

## The real insight

We don't have "strings" and "JSON objects" and "validated data". We have strings that represent structured data. The transformation from one to the other isn't a side effect. It's part of the type.

That's what morphs are. They're not validators that happen to transform data. They're types that include their own transformation logic.

```typescript
// You can chain with .to for more complex transformations
const parseApiResponse = type("string.json.parse").to({
  name: "string",
  version: "string.semver"  // Even validates semver format!
});
```

## Here's what actually shipped

```typescript
import { type } from 'arktype';
import { getProxiedBaseUrl } from '$lib/client/utils/proxy-url';

const parseNgrokTunnels = type("string.json.parse").to({
  tunnels: [{
    public_url: 'string',
    proto: '"http" | "https"',
    config: {
      addr: 'string'
    }
  }]
});

async function autoDetectNgrokUrl() {
  const response = await fetch(`${getProxiedBaseUrl('http://localhost:4040')}/api/tunnels`);
  const text = await response.text();
  const parsed = parseNgrokTunnels(text);

  if (parsed instanceof type.errors) {
    toast.error('Invalid ngrok response');
    return;
  }

  const httpsUrl = parsed.tunnels.find(t => t.proto === 'https')?.public_url;
  if (httpsUrl) {
    ngrokUrl = httpsUrl;
    toast.success('URL detected!');
  }
}
```

No type assertions. No manual parsing. No separate validation step. Just data transformation that's part of the type system.

The lesson: Stop thinking of JSON parsing and validation as separate operations. They're not. They're a single transformation from "string that might contain JSON" to "typed data I can use".

And arktype gets that.