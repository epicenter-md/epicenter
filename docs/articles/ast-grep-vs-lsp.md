# AST-Grep vs LSP: Know the Difference

You should know the difference between AST-Grep and LSP. They both help you search and transform code, but they work completely differently. Understanding when to use which will save you hours.

## AST-Grep: Structural Pattern Matching

AST-Grep is basically grep, but it understands code structure. When you search for `console.log($MSG)`, it's not matching text. It's not looking for the literal string "console.log". It's parsing your code into an Abstract Syntax Tree and matching the _shape_ of function calls.

That `$MSG` is a meta-variable. It captures whatever's in that position:

```javascript
console.log('hello'); // $MSG = "hello"
console.log(user.name); // $MSG = user.name
console.log(await fetchData()); // $MSG = await fetchData()
```

All three match. AST-Grep doesn't care about whitespace, comments, or formatting. It sees the tree structure, not the text.

Here's the magic: you can replace with those same meta-variables:

```
pattern: console.log($MSG)
rewrite: logger.info($MSG)
```

Run that across your codebase and every `console.log` becomes `logger.info`, preserving whatever was inside the parentheses. That's a one-liner refactor that would be error-prone with find-and-replace.

## LSP: Semantic Symbol Tracking

LSP is what powers the "Rename Symbol" feature in VS Code. When you right-click a function and rename it, the editor doesn't just find-and-replace the text. It _understands_ what that symbol is.

Say you have a function called `getUserData` defined in `utils.ts`. You import it in `dashboard.tsx`. You re-export it from `index.ts`. You reference it in a type annotation somewhere else.

When you rename through LSP, it traces the actual symbol identity across all those files. The import, the re-export, the type reference; they all get updated. It knows that `getUserData` in file A is the same function as the imported `getUserData` in file B, even though they're in different files.

This is semantic understanding. LSP maintains a model of your entire project: types, symbols, references, imports, everything.

## The Key Difference

AST-Grep sees structure. LSP sees meaning.

AST-Grep asks: "Does this code match this pattern?"
LSP asks: "Is this the same symbol as that one?"

When you use AST-Grep to rename `getUserData`:

```
pattern: getUserData($$$)
rewrite: fetchUserData($$$)
```

It'll catch all the _call sites_ that match. But it won't rename the function definition. It won't update imports. It might accidentally rename a completely unrelated function that happens to have the same name in a different module.

When you use LSP to rename `getUserData`, it starts from a specific position, line 42, character 15, and says: "This symbol, and everything that references this exact symbol, should now be called `fetchUserData`."

## When to Use Which

Use LSP Rename when you want to safely rename a specific symbol. It's precise, it's safe, it understands your whole project.

Use AST-Grep when you want to transform patterns across your codebase. Converting all `console.log` to `logger.info`. Wrapping all `fetch` calls in error handling. Migrating from one API pattern to another.

Think of it this way: LSP is a surgeon with a scalpel. AST-Grep is a power tool for bulk operations.

Both are essential. Neither replaces the other.

## Quick Reference

| Scenario                                            | Tool     |
| --------------------------------------------------- | -------- |
| Rename a function safely                            | LSP      |
| Find all usages of a symbol                         | LSP      |
| Convert `console.log` → `logger.info` everywhere    | AST-Grep |
| Find all async functions that don't have try-catch  | AST-Grep |
| Check what type a variable is                       | LSP      |
| Refactor the same pattern across multiple languages | AST-Grep |

The best developers know both. Use the right tool for the job.
