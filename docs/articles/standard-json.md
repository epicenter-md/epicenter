# Standard JSON: The Missing Bridge Between Type Validation Libraries and JSON Schema

I stumbled into this library called [standard-json](https://github.com/standard-community/standard-json) and it changed my life. Finally, I can convert standard schema into JSON schema.

It came from a really unexpected way. I was looking at [Hono OpenAPI](https://hono.dev/examples/hono-openapi) the other day. The package showed exmaples with various standard schema libraries (Zod, Arktype, Valibot, etc.), but something didn't add up. (First off, great to see more documentation of hono's standard validator. I noticed that it was mentioned in https://hono.dev/examples/hono-openapi but nowhere in https://hono.dev/docs/guides/validation, so I made a PR to add it in https://hono.dev/docs/guides/validation#standard-schema-validator-middleware).

I and I was like, "Wait a minute, OpenAPI requires JSON Schema. How did they take in a standard schema and turn it into a JSON schema that they notoriously?" Standard Schema has no way to allow you to introspect and turn it into a JSON schema, since every implementation is different under the hood (see my article on that).

So I looked into the source code and I dug into the dependencies. The answer: a tiny library called [standard-json](https://github.com/standard-community/standard-json).

## What It Does

Standard JSON converts any [Standard Schema](https://github.com/standard-schema/standard-schema) implementation to JSON Schema. That's it. One job, done well.

```typescript
import { type } from 'arktype';
import { toJsonSchema } from 'standard-json';

const User = type({
  id: 'string',
  email: 'string',
  age: 'number'
});

const schema = await toJsonSchema(User);
// Valid JSON Schema object, ready for OpenAPI or any other tool
```

Works with Zod, Arktype, Valibot, Typebox, anything that implements Standard Schema.

The return type is a JSONSchema7 from https://www.npmjs.com/package/@types/json-schema.

## Why This Matters

Before Standard Schema and this library, every validation library had its own way of doing things. If you wanted to generate OpenAPI docs, you either:

- Used one specific library (usually Zod because that's what your tooling supported) or Typebox (JSON Schema native)

Standard Schema standardized the interface. Standard JSON handles the conversion. Now tools like Hono OpenAPI can support every validation library without writing custom code for each one.

## How I Found It

The install command for Hono OpenAPI is:
```bash
npm install hono-openapi @hono/standard-validator
```

That's it. Just [`@hono/standard-validator`](https://www.npmjs.com/package/@hono/standard-validator) (which has terrible SEO, by the way). No validation library dependencies. Bring your own.

I thought: "Wait, how does this actually work?" Looked at the package dependencies. Found standard-json. Everything clicked.

## The Ecosystem Gap This Fills

There's been a frustrating gap in the JavaScript ecosystem. Everyone has strong opinions about validation libraries (Zod vs Arktype vs Valibot debates get heated). But tooling that needs JSON Schema has been locked into specific choices.

Standard JSON means you can:
- Use whatever validation library fits your needs that implements `standard-schema`
- Generate OpenAPI specs automatically
- Share schemas across tools that expect JSON Schema
- Not rewrite your validation logic when you switch libraries

This is huge for anyone building APIs. You get type safety, runtime validation, and API documentation from a single source of truth.

## Why It Needs More Attention

This library changed how I think about API schema management. I can finally use Arktype (my preferred validation library) and still generate proper OpenAPI specs. No compromises.

The fact that it has such poor discoverability is a shame. I only found it by reading source code. If you're using Standard Schema-compatible libraries and need JSON Schema output, this is the answer.

GitHub: https://github.com/standard-community/standard-json
Standard Schema: https://github.com/standard-schema/standard-schema

---

Has anyone else run into this problem? What solutions have you been using?
