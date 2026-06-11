# Every YType Is Both a Map AND a List Simultaneously

In v14, there's no longer separate `Y.Map`, `Y.Array`, `Y.Text`, `Y.XmlElement`. There's just `YType`. Every instance has two internal data structures:

- `_map`: key-value pairs (the "map" side), accessed via `setAttr`/`getAttr`
- `_start`: a doubly-linked list of ordered children (the "list" side), accessed via `insert`/`push`/`get`

You can use both on the same instance freely:

```js
import { Doc, Type } from '@y/y'

const ydoc = new Doc()
const thing = ydoc.get('thing')

// Map side
thing.setAttr('title', 'My Document')
thing.setAttr('version', 3)

// List side: same instance!
thing.insert(0, ['item1', 'item2'])
thing.push(['item3'])

// Both coexist independently
thing.getAttr('title')  // 'My Document'
thing.get(0)            // 'item1'
thing.attrSize          // 2
thing.length            // 3
```

Think of it like an HTML element: `<div class="foo">hello</div>` has both attributes and children. That's the universal model now.
