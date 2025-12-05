# Proxies vs Object.defineProperty: Two Ways to Intercept Property Access

Both Proxies and `Object.defineProperty` are metaprogramming tools that let you customize what happens when someone accesses a property on an object. Instead of just returning a value, you can run custom logic. But they work differently and suit different use cases.

## Object.defineProperty: Per-Property Customization

`Object.defineProperty` lets you define a specific property with custom getter and setter functions:

```javascript
const user = { firstName: 'Jane', lastName: 'Doe' };

Object.defineProperty(user, 'fullName', {
  get() {
    return `${this.firstName} ${this.lastName}`;
  },
  set(value) {
    [this.firstName, this.lastName] = value.split(' ');
  }
});

console.log(user.fullName); // "Jane Doe"
```

The getter runs every time you access `fullName`. The property descriptor becomes part of the object itself.

## Proxy: Intercept Everything

A Proxy wraps an entire object and intercepts operations on it:

```javascript
const user = { firstName: 'Jane', lastName: 'Doe' };

const proxy = new Proxy(user, {
  get(target, prop) {
    console.log(`Reading ${prop}`);
    return target[prop];
  }
});

console.log(proxy.firstName); // Logs "Reading firstName", returns "Jane"
```

The proxy intercepts ALL property access, including properties that don't exist yet.

## The Key Distinction

`Object.defineProperty` is explicit and targeted. You decide upfront which properties get custom behavior. The behavior is baked into the object.

Proxies are dynamic and comprehensive. You intercept everything at runtime. The proxy is a wrapper around the target object.

## When to Use What

**Use Object.defineProperty when:**
- You need to customize specific, known properties
- You want explicit, self-documenting code
- Performance matters (direct property access is faster)
- You need broad browser support

**Use Proxy when:**
- You want to intercept all property access dynamically
- You're building reactive systems or validation layers
- You need to intercept operations beyond get/set (like delete, enumerate)
- You don't know which properties will be accessed ahead of time

## Trade-offs

`Object.defineProperty` pros: explicit, performant, widely supported. Cons: verbose, can't handle dynamic properties.

Proxy pros: flexible, powerful, less boilerplate. Cons: performance overhead, can't be polyfilled, less transparent.

## The Bottom Line

Both let you run code when properties are accessed. `Object.defineProperty` is surgical; Proxies are comprehensive. Choose based on whether you need targeted customization or blanket interception.
