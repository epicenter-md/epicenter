# Keep Branded Strings with $type<T>() in Drizzle

> See [PR #1216](https://github.com/EpicenterHQ/epicenter/pull/1216) for the full context on this pattern.

**TL;DR**: Use `$type<T>()` to keep data in its intermediate string representation while still getting type safety. No runtime conversion, no `mapFromDriverValue` overhead.

## The Goal

I want to store dates as branded strings (`DateTimeString`) and keep them that way through the entire system. Database to API to frontend. Only parsing into rich `Temporal` objects at the very last moment (UI binding). Then immediately serialize back.

The rule: **if data enters serialized and leaves serialized, keep it serialized in the middle. Parse at the edges where you actually need the rich representation.**

## The Journey

I started with a `customType` that actually did work. Parsing the string into a `Temporal.ZonedDateTime` on read:

```typescript
// Where I started: parsing on every read
customType<{ data: Temporal.ZonedDateTime; driverParam: string }>({
	dataType: () => 'text',
	toDriver: (value) => toDateTimeString(value),
	fromDriver: (value) => fromDateTimeString(value), // string → Temporal
});
```

Then I realized I was parsing into Temporal objects just to serialize them back to strings at API boundaries. The rich object was only needed briefly in UI components. So I changed to keeping strings:

```typescript
// Step 2: keep strings, symmetric identity functions
customType<{ data: DateTimeString; driverParam: DateTimeString }>({
	dataType: () => 'text',
	toDriver: (value) => value,
	fromDriver: (value) => value,
});
```

But then I looked closer. Even with identity functions, Drizzle still runs through `mapFromDriverValue` on every read:

```typescript
// drizzle-orm/src/utils.ts - runs for EVERY column of EVERY row
const rawValue = row[columnIndex]!;
const value = rawValue === null ? null : decoder.mapFromDriverValue(rawValue);
```

Even if my `fromDriver` is just `(x) => x`, Drizzle still calls it 3000 times for a query with 1000 rows and 3 date columns. That's function call overhead for data that's already in the format I want.

So I reached for `$type<T>()`.

## $type<T>() Keeps the Intermediate Representation

`$type<T>()` is a pure compile-time type assertion. From Drizzle's source:

```typescript
// drizzle-orm/src/column-builder.ts
$type<TType>(): $Type<this, TType> {
  return this as $Type<this, TType>;
}
```

It returns `this` cast to a different type. No function registered, no `mapFromDriverValue` calls, no runtime overhead. The database stores TEXT, TypeScript sees `DateTimeString`, and the data stays in its intermediate string form.

```typescript
// Zero runtime overhead - data stays as-is
text().$type<DateTimeString>();
```

This is exactly what I want: type safety for the branded string without forcing any conversion. The data enters as a string from SQLite, stays a string through my API layer, stays a string to the frontend, and only gets parsed into a `Temporal` object right when the date-time picker needs it.

## When You Actually Need customType

`customType` is for when the data genuinely transforms between your app and the database:

```typescript
// JSON: object in app, string in database - actual transformation
customType<{ data: UserPrefs; driverParam: string }>({
	toDriver: (value) => JSON.stringify(value),
	fromDriver: (value) => JSON.parse(value),
});
```

Here `fromDriver` does real work. You should be careful when you do it, since it adds runtime cost (see my other articles about keeping the intermediate representation for as long as possible, and lazily evaluate it close to the boundaries where they are needed, like the UI elements).

But for branded strings where the underlying data doesn't change, `$type<T>()` gives you type safety without the overhead.

## The Rule

If the data doesn't actually transform. Just needs a more specific TypeScript type. Use `$type<T>()`. Keep the intermediate representation. Parse at the edges.
