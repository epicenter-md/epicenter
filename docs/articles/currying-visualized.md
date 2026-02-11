# Currying, Visualized

A simple mental model.

---

```
OBJECT-METHOD                    CURRIED
─────────────────────────────────────────────────

factory(config).run(input)       factory(config)(input)
              │                              │
              └── remove ".run" ─────────────┘
```

That's it. Currying is just calling the object directly instead of calling a method on it.

---

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   factory(config).run()        factory(config)()            │
│                  ════                        ═══            │
│                   │                           │             │
│                   └─── same thing ────────────┘             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

When your object only has one method, you can skip naming it.

---

## The Code

```typescript
// OBJECT-METHOD
function factory(config) {
	return {
		run(input) {
			// use config and input
		},
	};
}

factory(config).run(input);

// CURRIED
function factory(config) {
	return (input) => {
		// use config and input
	};
}

factory(config)(input);
```
