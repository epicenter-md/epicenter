# Vim-Surround: The Spacing Rule You Need to Know

If you use vim-surround, there's one crucial behavior that will save you confusion: **opening delimiters add spaces, closing delimiters don't**.

This isn't a bug. It's intentional design that mirrors how most developers format their code.

## How I Discovered This

I was using `ysa(` versus `ysab` and noticed the surround behavior was completely different. One added spaces, the other didn't. I was very confused.

It took me four years of using Vim to discover this rule.

## The Core Rule

When you surround text with vim-surround:

- Use the **closing delimiter** (`]`, `)`, `}`, `>`) → **no spaces**
- Use the **opening delimiter** (`[`, `(`, `{`, `<`) → **adds spaces**

## Examples

### Parentheses

```vim
" Original text: hello
ysiw)    → (hello)     " closing paren, no spaces
ysiw(    → ( hello )   " opening paren, adds spaces
```

### Square Brackets

```vim
" Original text: hello
ysiw]    → [hello]     " closing bracket, no spaces
ysiw[    → [ hello ]   " opening bracket, adds spaces
```

### Curly Braces

```vim
" Original text: hello
ysiw}    → {hello}     " closing brace, no spaces
ysiw{    → { hello }   " opening brace, adds spaces
```

### Angle Brackets

```vim
" Original text: hello
ysiw>    → <hello>     " closing angle, no spaces
ysiw<    → < hello >   " opening angle, adds spaces
```

## Why This Matters

This design choice reflects common code formatting conventions:

**No spaces** (closing delimiters):
- Array access: `array[index]`
- Function calls: `func(arg)`
- Object literals: `{key: value}`
- Type parameters: `List<String>`

**With spaces** (opening delimiters):
- Destructuring: `const { name } = obj`
- Conditional blocks: `if ( condition )`
- Array literals with spaces: `[ 1, 2, 3 ]`

## Common Commands Comparison

| Command | Result | Description |
|---------|--------|-------------|
| `ysiw)` | `(word)` | Surround word with parens, no spaces |
| `ysiw(` | `( word )` | Surround word with parens, with spaces |
| `ysiw]` | `[word]` | Surround word with brackets, no spaces |
| `ysiw[` | `[ word ]` | Surround word with brackets, with spaces |
| `ysiw}` | `{word}` | Surround word with braces, no spaces |
| `ysiw{` | `{ word }` | Surround word with braces, with spaces |
| `ysiw>` | `<word>` | Surround word with angles, no spaces |
| `ysiw<` | `< word >` | Surround word with angles, with spaces |
| `ysiwb` | `(word)` | Same as `)`, no spaces (b = bracket) |
| `ysiwB` | `{word}` | Same as `}`, no spaces (B = Brace) |

## Text Objects with Surround

The same rule applies when using text objects:

```vim
" Surround inside parentheses
ysa))    → (already wrapped)     " no spaces
ysa((    → ( already wrapped )   " with spaces

" Surround around word
ysawb    → (word)                " no spaces (b is alias for ))
ysaw(    → ( word )              " with spaces
```

## Quick Reference

### No Spaces (Closing Delimiters)
- `)` or `b` → `(text)`
- `]` → `[text]`
- `}` or `B` → `{text}`
- `>` → `<text>`

### With Spaces (Opening Delimiters)
- `(` → `( text )`
- `[` → `[ text ]`
- `{` → `{ text )`
- `<` → `< text >`

## Pro Tips

1. **Most of the time, use closing delimiters**: `ysiw)`, `ysiw]`, `ysiw}` because most code doesn't have spaces inside delimiters.

2. **Use opening delimiters for destructuring**: When writing JavaScript/TypeScript destructuring, use `{` to get `{ name }`.

3. **Remember the aliases**:
   - `b` = `)` (bracket)
   - `B` = `}` (Brace)
   - These only work for the no-space versions

4. **Changing existing surrounds**: When using `cs` (change surround), the same rules apply:
   ```vim
   cs)(    " changes (word) to ( word )
   cs({    " changes (word) to { word }
   ```

## Common Confusion

The most common confusion happens with `ysab` commands:

```vim
ysabb    " means: surround 'a block ()' with 'b (closing paren)'
         " result: (existing text with parens)

ysa((    " means: surround 'a ()' with '( (opening paren)'
         " result: ( existing text with parens )
```

The second `b` in `ysabb` is the delimiter you're adding, not part of the text object.

## The Bottom Line

When in doubt, remember: **closing delimiter = tight, opening delimiter = spaced**.

This simple rule will make your vim-surround experience much more predictable and efficient.
