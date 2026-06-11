# The Asymmetric Getter/Setter Pattern

A common TypeScript pattern I like is the asymmetric getter/setter pattern. This is where you expose a getter for reading state with dot syntax, but instead of using a corresponding setter (`obj.value = x`), you use an explicit method (`obj.setValue(x)`).

## The Pattern

```typescript
function createHead() {
	let meta: Meta | null = null;

	return {
		// Getter: natural property access
		get meta(): Meta | null {
			return meta;
		},

		// Setter: explicit method call
		setMeta(newMeta: Meta): void {
			// validation, side effects, etc.
			meta = newMeta;
		},
	};
}

// Usage
const head = createHead();
const currentMeta = head.meta; // Reading feels like accessing data
head.setMeta({ name: 'author' }); // Writing feels like performing an action
```

## Why Asymmetric?

The asymmetry is intentional. Reading and writing often have different semantics:

**Reading** is usually safe and side-effect free. You're just observing state. Property syntax (`head.meta`) feels natural because it _is_ just data access.

**Writing** often involves validation, side effects, or coordination. A method call (`head.setMeta(...)`) makes the boundary explicit. When you see a method call, you expect something to _happen_; when you see property access, you expect to just _get a value_.

## This is a DOM Pattern

You might think this asymmetry is unusual, but it's exactly what the DOM does:

```typescript
// Reading: property access
const currentValue = input.value;

// Writing: method call
input.setAttribute('value', 'new value');
```

The `element.value` property isn't a static field. It's a getter function that V8 calls synchronously when you access it. Under the hood, the DOM uses WebIDL to define these:

```webidl
interface HTMLInputElement : HTMLElement {
  attribute DOMString value;  // Compiles to getter/setter pair in C++
};
```

When you access `element.value`, JavaScript calls a native getter that returns the current state. The DOM chose to expose `setAttribute()` as a method because setting attributes can have significant side effects (re-rendering, validation, event dispatch).

## Comparing Alternatives

Let's look at what other approaches would look like:

### Symmetric Methods (Java-style)

```typescript
function createHead() {
	let meta: Meta | null = null;

	return {
		getMeta(): Meta | null {
			return meta;
		},
		setMeta(newMeta: Meta): void {
			meta = newMeta;
		},
	};
}

// Usage
const meta = head.getMeta(); // Feels like an operation, not data access
head.setMeta({ name: 'author' });
```

This is consistent, but `getMeta()` feels heavier than necessary. You're not _doing_ anything. You're just reading. The parentheses add visual noise for a simple read operation.

### Symmetric Properties (Full getter/setter)

```typescript
function createHead() {
	let _meta: Meta | null = null;

	return {
		get meta(): Meta | null {
			return _meta;
		},
		set meta(value: Meta) {
			_meta = value;
		},
	};
}

// Usage
const meta = head.meta;
head.meta = { name: 'author' }; // Looks like simple assignment
```

This reads nicely, but `head.meta = x` hides the fact that something significant might happen. If setting meta triggers validation, persists to storage, or notifies observers, the assignment syntax undersells the complexity. Someone reading the code might assume it's a simple field write.

### Asymmetric (The DOM Pattern)

```typescript
function createHead() {
	let meta: Meta | null = null;

	return {
		get meta(): Meta | null {
			return meta;
		},
		setMeta(newMeta: Meta): void {
			meta = newMeta;
		},
	};
}

// Usage
const meta = head.meta; // Just reading data
head.setMeta({ name: 'author' }); // Clearly doing something
```

Reading is frictionless; writing is explicit. The visual difference between `head.meta` and `head.setMeta(...)` signals the semantic difference between observation and mutation.

## When to Use This Pattern

Use asymmetric getters when:

- Reading is frequent and should feel lightweight
- Writing has side effects, validation, or coordination logic
- You want the code to visually distinguish reads from writes
- You're following an existing ecosystem convention (like YJS: `doc.clientID` but `doc.transact()`)

Use symmetric methods (`getFoo`/`setFoo`) when:

- Both reading and writing are complex operations
- You want maximum consistency (common in Java-influenced codebases)

Use symmetric properties (`get`/`set`) when:

- The setter is truly simple with no significant side effects
- You're building a data container where assignment semantics make sense

## Summary

The asymmetric getter/setter pattern isn't a compromise. It's intentional API design that matches how the DOM works. Properties feel like data; methods feel like actions. When reading state is simple but writing state is significant, let the syntax reflect that difference.
