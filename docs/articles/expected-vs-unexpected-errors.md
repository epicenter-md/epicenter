# Expected vs Unexpected Errors

I was writing a deserialization function and hit this decision: should it return a Result type, or just throw on failure? The answer turned out to hinge on a simple question: what does failure actually mean in this context?

## The Real Code

Here's the actual function from our codebase that deserializes date-with-timezone data:

```typescript
export function DateWithTimezoneFromString(
	serialized: DateWithTimezoneString,
): DateWithTimezone {
	if (!isDateWithTimezoneString(serialized)) {
		throw new Error(`Invalid DateWithTimezone format: ${serialized}`);
	}

	// ISO string is always first 24 characters, pipe at index 24, timezone after
	const isoUtc = serialized.slice(0, 24);
	const timezone = serialized.slice(25);

	return DateWithTimezone({ date: new Date(isoUtc), timezone });
}
```

The function takes a `DateWithTimezoneString` (a branded type for strings in the format `"2024-01-01T20:00:00.000Z|America/New_York"`) and converts it back into a `DateWithTimezone` object. It validates the format using a type guard, and if validation fails, it throws an error.

Here's that type guard:

```typescript
export function isDateWithTimezoneString(
	value: unknown,
): value is DateWithTimezoneString {
	if (typeof value !== 'string') return false;

	// ISO 8601 UTC string is always 24 chars with 'Z' at position 23, pipe at 24
	// Format: "YYYY-MM-DDTHH:mm:ss.sssZ|timezone"
	return value.length > 25 && value[23] === 'Z' && value[24] === '|';
}
```

Notice what this function does: it checks the structural format of the serialized string. The ISO 8601 UTC format from `Date.toISOString()` is always exactly 24 characters, ending with 'Z'. Then there's a pipe separator at position 24, followed by the timezone name.

## Understanding the Invariant

The key insight here is what `DateWithTimezoneFromString` is actually doing. It's not parsing arbitrary user input. It's deserializing data that the system itself created using the `toJSON()` method:

```typescript
export function DateWithTimezone({
	date,
	timezone,
}: {
	date: Date;
	timezone: string;
}): DateWithTimezone {
	return {
		date,
		timezone,
		toJSON() {
			return `${date.toISOString()}|${timezone}` as DateWithTimezoneString;
		},
	};
}
```

When you serialize a `DateWithTimezone` object, it produces a string in the exact format that `DateWithTimezoneFromString` expects. This creates an invariant: if the system is working correctly, deserialization should always succeed. The serialization function produces valid output, and the deserialization function consumes that same valid output.

If `DateWithTimezoneFromString` fails, it means one of several things has gone wrong. Maybe the data got corrupted in storage. Maybe someone bypassed the type system and passed a random string. Maybe there's a bug in the serialization logic that produces invalid output. Maybe the deserialization logic changed but serialization didn't, or vice versa.

Whatever the cause, failure indicates a bug. Not a normal error condition, but something fundamentally broken in the system's assumptions.

## The Contrast with Expected Errors

Compare this to parsing user input, where failure is completely normal:

```typescript
function parseDateFromUserInput(input: string): Result<DateWithTimezone, ValidationError> {
  return trySync({
    try: () => {
      // Parse user's date string
      const parsed = parseUserDateFormat(input);
      return Ok(parsed);
    },
    catch: (e) => {
      return ValidationErr({
        message: "Invalid date format",
        cause: e
      });
    }
  });
}
```

This function returns a Result type because users type invalid dates all the time. That's not a bug in the system; it's normal operation. The caller needs to handle both success and failure: show an error message, ask the user to try again, use a fallback value, whatever makes sense for that specific use case.

The pattern becomes clear: expected errors belong in the return type. Unexpected errors get thrown.

## Defensive Validation

You might wonder: if `DateWithTimezoneFromString` assumes the input is valid, why validate at all? Why not just slice the string and trust it?

The validation serves as defensive programming. The invariant should hold, but if it doesn't, we want to know immediately. The alternative is to continue with corrupted state and have the system fail mysteriously later, making it much harder to trace the root cause. By validating the format and throwing a clear error at the point of deserialization, we catch bugs early with a meaningful error message that points directly to the problem.

The validation verifies the invariant. The throw stops execution when the invariant is violated. This is how you catch bugs in development and prevent them from cascading into worse problems in production.

## The Decision Framework

When writing a function that could fail, I ask myself: does the caller need to handle this error case as part of normal operation?

If yes, it's an expected error. Return a Result type. The caller might want to retry the operation, show a message to the user, use a fallback value, log the error for later review, or handle it in some other specific way that depends on context.

If no, because failure indicates a bug in the code, it's an unexpected error. Throw an exception. The right "handling" is to fix the bug, not to write error handling code. When you throw, you're saying: this should never happen, and if it does, we need to stop and fix the underlying problem.

Here are some examples:

User input validation: expected error, return Result. Users commonly provide invalid input.

Parsing data I serialized myself: unexpected error, throw. The data should be valid because I created it.

Network request to an external service: expected error, return Result. Networks are unreliable, services go down, timeouts happen.

Array index that should always be in bounds: unexpected error, throw. If you're accessing an out-of-bounds index, your logic is wrong.

Reading a required config file: unexpected error, throw. The app can't run without it, so failure is a setup problem.

Reading an optional config file: expected error, return Result. The absence of the file is normal, and you have fallback behavior.

## Cross-Language Patterns

This distinction between expected and unexpected errors shows up across programming languages, though the terminology varies. Rust has `Result` for expected errors and `panic!` for unexpected ones. Go uses error values for expected cases and `panic` for unexpected ones. Even languages without sum types distinguish between expected errors (checked exceptions in Java) and unexpected ones (unchecked exceptions or runtime errors).

The universal insight: failure has different meanings. Some failures are part of normal operation. Others indicate bugs. Your error handling strategy should reflect that difference, regardless of the specific mechanisms your language provides.

## The Lesson

Not every failure case needs to be in your return type. Some failures are bugs, not error conditions.

When you're validating invariants (assumptions about your own code being correct), throw. When you're handling expected failures (things that commonly happen during normal operation), return Result. The distinction is about who's responsible: if it's the caller's job to handle the error, return Result. If it's your job as the library author to fix the bug, throw.

The code often tells you which is which. If you're writing defensive validation with `if (!someInvariant) throw new Error(...)`, that's unexpected error handling. If you're writing `trySync` or `tryAsync` with a catch handler that returns `Ok(fallback)`, that's expected error handling.

Ask yourself: is this the caller's problem to handle, or is this my problem to fix? That question separates expected errors from unexpected ones.
