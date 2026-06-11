# Your Private Methods Are Classes Waiting to Be Extracted

**TL;DR**: Private methods that share dependencies belong in their own class. Extract them, inject the new classes back in, and the original class becomes a thin orchestrator with zero private methods.

> In general, avoid having too many private methods. It's usually a sign that you can extract them out and make them testable. Not a hard-and-fast rule, but a common one for composition.

I had a class with seven private helper methods. On the surface it looked fine: each method was small, well-named, used by the public API. But when I looked at what each method actually depended on, a pattern jumped out:

```typescript
class YjsFileSystem {
  private table: TableHelper<FileRow>;
  private index: FileSystemIndex;
  private store: ContentDocStore;

  private resolveId(path: string) {           // ◄ uses index
    return this.index.lookup(path);
  }

  private getRow(id: FileId) {                // ◄ uses table
    return this.table.get(id);
  }

  private parsePath(path: string) {           // ◄ uses index
    const parent = this.index.lookup(dirname(path));
    return { parentId: parent, name: basename(path) };
  }

  private assertDirectory(id: FileId) {       // ◄ uses table
    if (this.table.get(id).type !== 'folder') throw fsError('ENOTDIR');
  }

  private getActiveChildren(parentId) {       // ◄ uses table
    return this.table.filter(r => r.parentId === parentId && !r.trashedAt);
  }
  //  ▲ all 5 touch table + index, none touch store
  //    → they're a class: FileTree(table, index)
```

Five of them touch `table` and `index`. None of them touch `store`. They're a cluster: "everything about navigating and querying the file tree." The sixth method, `softDeleteAll`, straddles both concerns. That's a coordination problem, not a data problem.

Meanwhile, every public read/write method had the same inline pattern hiding in plain sight:

```typescript
  async readFile(path: string) {
    const id = this.resolveId(path);
    const doc = await this.store.ensure(id);       // ◄─┐
    const timeline = getTimeline(doc);              //   │ repeated in
    const entry = getCurrentEntry(timeline);        //   │ every read/write
    return readEntryAsString(entry);                // ◄─┘
  }

  async writeFile(path: string, data: string) {
    // ...
    const doc = await this.store.ensure(id);       // ◄─┐
    const timeline = getTimeline(doc);              //   │ same pattern
    const current = getCurrentEntry(timeline);      //   │ again
    doc.transact(() => { /* ... */ });              // ◄─┘
  }
  //  ▲ every public method repeats ensure → timeline → transact
  //    → that's a class: ContentOps(store)
}
```

Load a doc from the store, get the timeline, figure out the content mode, transact. That's a second cluster, just not factored into private methods yet.

Two clusters, two classes.

Every old private method becomes a public method on the right class. No private helpers needed on any of the three classes because the decomposition itself eliminates them.

The one cross-cutting method (`softDeleteAll`) dissolves into orchestration: `TreeOps` returns the descendant IDs, the outer class loops through them calling `tree.softDelete(id)` and `content.destroy(id)`. The knowledge of which IDs to delete lives in the tree. The knowledge of how to destroy content lives in the content layer. The sequence lives in the orchestrator. Clean.

This changes how you test, too. Look at what happens to the constructor:

```typescript
// BEFORE: 3 low-level dependencies, tightly coupled
constructor(
  private table: TableHelper<FileRow>,  // ─┐ travel together
  private index: FileSystemIndex,       // ─┘ but wired separately
  private store: ContentDocStore,       // independent concern
) {}
// To test ANYTHING, you must wire up ALL THREE

// AFTER: 2 high-level collaborators
constructor(
  private tree: FileTree,      // ◄ bundles table + index
  private content: ContentOps, // ◄ bundles store + timeline logic
) {}
```

And what that means for tests:

```typescript
// Before: need ALL dependencies to test ANYTHING
const fs = new YjsFileSystem(realTable, realIndex, realStore);
fs.readFile('/test.txt');
//  ▲ just wanted to test path resolution
//    but had to construct a ContentDocStore too

// After: test each piece with only what it needs
const tree = new FileTree(mockTable);
tree.resolveId('/foo/bar');     // ◄ no store needed

const content = new ContentOps();
await content.read(someId);     // ◄ no table/index needed

const fs = new YjsFileSystem(mockTree, mockContent);
await fs.readFile('/test.txt'); // ◄ verify orchestration only
```

That's what dependency injection buys you here. Before extraction, the class has N low-level dependencies and every test must wire up all of them. After extraction, related dependencies are bundled into named collaborators. The orchestrator depends on 2-3 high-level things instead of N low-level things, and each collaborator can be tested, or mocked: independently.

The heuristic is simple: list your private methods and write down what each one touches. If they cluster into groups that share some dependencies but not others, you're looking at hidden classes. Extract each cluster, inject them into the original class, and what remains is a thin orchestrator with no private methods at all.

Not always the right move. A class with two private helpers that both touch the same single dependency doesn't need splitting; that's just encapsulation doing its job. The signal is clusters with different dependency profiles. When you see that, the extraction pays for itself in testability and clarity.
