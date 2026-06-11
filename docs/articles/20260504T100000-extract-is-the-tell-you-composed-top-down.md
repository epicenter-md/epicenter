# Extract<> Is the Tell That You Composed Top-Down

`Extract<>` in TypeScript is often a code smell. If you find yourself reaching for `Extract<MyError, { name: 'X' }>` to narrow a method's return type, you probably should have composed those types or split them off in the beginning. The natural instinct should be to break it up. Instead of having a single type that you derive everything from, compose smaller types per method or per fault domain, and let them combine naturally at the boundary that actually needs the union.

Here's the smell. One transport file, one error union, four methods that all claim to return it:

```typescript
export const MachineAuthTransportError = defineErrors({
  RequestFailed:             ({ cause }) => ({...}),
  DeviceCodeExpired:         () => ({...}),
  DeviceAccessDenied:        () => ({...}),
  DeviceAuthorizationFailed: ({ code, description }) => ({...}),
});

return {
  async requestDeviceCode(): Promise<Result<DeviceCodeResponse,    MachineAuthTransportError>> { ... },
  async pollDeviceToken():   Promise<Result<DevicePollOutcome,     MachineAuthTransportError>> { ... },
  async fetchSession():      Promise<Result<{ session },           MachineAuthTransportError>> { ... },
  async signOut():           Promise<Result<undefined,             MachineAuthTransportError>> { ... },
};
```

Walk the bodies. Only `pollDeviceToken` ever constructs the three OAuth variants; the OAuth response classification only happens there. The other three methods only ever produce `RequestFailed`. Three of four signatures are lying about what they can return.

The top-down patch looks like this:

```typescript
async requestDeviceCode(): Promise<
  Result<DeviceCodeResponse, Extract<MachineAuthTransportError, { name: 'RequestFailed' }>>
> { ... },
```

Each method asserts "I am a subset of the union I've already declared too wide." That's the disingenuous part. The signature is a patch on a decision the union got wrong, not a description of the function.

## The bottom-up version starts at fault domains

Group errors by what they describe, not by who throws them.

```typescript
export const MachineAuthRequestError = defineErrors({
  RequestFailed: ({ cause }) => ({...}),
});
export type MachineAuthRequestError = InferErrors<typeof MachineAuthRequestError>;

export const DeviceTokenError = defineErrors({
  DeviceCodeExpired:         () => ({...}),
  DeviceAccessDenied:        () => ({...}),
  DeviceAuthorizationFailed: ({ code, description }) => ({...}),
});
export type DeviceTokenError = InferErrors<typeof DeviceTokenError>;
```

`RequestFailed` is "the network call failed." That applies to anything making an HTTP request. The three Device errors are OAuth response classification, which only happens in the function that classifies an OAuth response. Two domains, two types, no shared parent that flattens them.

Now drop the explicit return-type annotations and let TypeScript infer from the bodies:

```typescript
return {
  async requestDeviceCode() {
    // body only constructs MachineAuthRequestError.RequestFailed
    // → infers Result<DeviceCodeResponse, MachineAuthRequestError>
  },
  async pollDeviceToken() {
    // body constructs RequestFailed AND the three DeviceToken variants
    // → infers Result<DevicePollOutcome, MachineAuthRequestError | DeviceTokenError>
  },
  async fetchSession() {
    // body only constructs RequestFailed
    // → infers Result<{ session }, MachineAuthRequestError>
  },
  async signOut() {
    // body only constructs RequestFailed
    // → infers Result<undefined, MachineAuthRequestError>
  },
};
```

Each signature now matches what the function actually does. No filter, no patch. The narrow types weren't extracted from a wide one; they were composed bottom-up and the wide one stopped existing.

If a caller wants the wide union it materializes naturally where the pieces meet:

```typescript
async function loginWithDeviceCode() {
  // requestDeviceCode → pollDeviceToken → fetchSession → save
  // The Result type at the end is naturally:
  //   Result<_, MachineAuthRequestError | DeviceTokenError | MachineAuthStorageError>
}
```

The aggregate union appears at the boundary that needs it. Nobody had to define it upfront and nobody has to filter it back down.

## When Extract<> is actually fine

The rule has an exception: external types you don't own. React's `JSX.IntrinsicElements`, Node's `ErrnoException['code']`, DOM event maps, Web Crypto algorithm names. You can't redefine them. Filtering them into local vocabulary is exactly what `Extract<>` is for.

```typescript
// Fine: JSX.IntrinsicElements is React's union
type BlockTag = Extract<keyof JSX.IntrinsicElements, 'div' | 'section' | 'article'>;

// Fine: NodeJS.ErrnoException is Node's
type FsExpectedCode = Extract<NodeJS.ErrnoException['code'], 'ENOENT' | 'EACCES'>;
```

The smell is when you both *defined* the union and *filter* it. You owned the composition; you just composed it wrong.

## The test

Reaching for `Extract<>` is fine when the union is upstream. It's a smell when the union is yours. Rule of thumb at the call site:

```txt
Do I own this union?

Yes → split it. The narrow types you need are the real types.
       The union was a premature aggregate.
       Define each piece, infer per method, union at the boundary.

No  → Extract is fine. You're filtering external vocabulary
       into the shape your code wants to think in.
```

The fix to a top-down union is rarely "filter it more cleverly." The fix is usually "define what each piece is, and let the union appear where the pieces meet."

The goal is not narrower types. The goal is types that match the code that produces them.
