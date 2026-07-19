/**
 * Workspace Runtime Tests
 *
 * Verifies the async release-lens surface assembled over one local canonical
 * SQLite owner.
 *
 * Key behaviors:
 * - open eagerly acquires storage and retries failed initialization
 * - table CRUD exposes create/update/delete/get/list
 * - every table exposes the singular row document capability
 * - KV and validated read-only SQL remain available
 * - synchronized owners expose one fixed workspace sync capability
 * - settlement waits for the invocation-time document durability barrier
 * - same-ID lenses share one raw owner and report nonconformance on read
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { field } from "@epicenter/field";
import { createBunSqliteAdapter } from "@epicenter/sqlite/bun";
import * as Y from "@y/y";
import { Type } from "typebox";
import { expectErr, expectOk } from "wellcrafted/testing";
import type { LogicalWorkspaceCopy } from "./canonical-addition.js";
import type {
  WorkspaceOwnerSync,
  WorkspaceSyncSettlement,
  WorkspaceSyncStatus,
} from "./canonical-sync-supervisor.js";
import { defineTable } from "./lens-definition.js";
import { initializeLocalWorkspaceStorage } from "./local-workspace-storage.js";
import { createWorkspaceRuntime } from "./runtime.js";
import { defineWorkspace } from "./workspace-lens.js";

const definition = defineWorkspace({
  id: "runtime-test",
  tables: {
    notes: defineTable({
      fields: { title: field.string(), archived: field.boolean() },
      optional: ["archived"],
    }),
  },
  kv: { theme: field.select(["light", "dark"]) },
});

const reportingLens = defineWorkspace({
  id: "runtime-test",
  tables: {
    notes: defineTable({
      fields: { title: field.string(), tags: field.tags() },
      optional: ["tags"],
    }),
  },
  kv: { theme: field.string() },
});

const numericTitleLens = defineWorkspace({
  id: "runtime-test",
  tables: {
    notes: defineTable({ fields: { title: field.number() } }),
  },
  kv: { theme: field.number() },
});

const invalidTableNameLens = defineWorkspace({
  id: "invalid-view-test",
  tables: {
    "bad-name": defineTable({ fields: { title: field.string() } }),
  },
});

const emptyLens = defineWorkspace({ id: "runtime-test", tables: {} });

function setupSynchronizedRuntime({
  initialStatus = { phase: "caught-up" },
  captureAdmissionCut = () => 0,
  settle = async (_cut: number) => ({ outcome: "caught-up" }),
  captureRecovery = async (): Promise<LogicalWorkspaceCopy | null> => null,
}: {
  initialStatus?: WorkspaceSyncStatus;
  captureAdmissionCut?: () => number;
  settle?: (cut: number) => Promise<WorkspaceSyncSettlement>;
  captureRecovery?: () => Promise<LogicalWorkspaceCopy | null>;
} = {}) {
  const database = new Database(":memory:");
  const sqlite = createBunSqliteAdapter(database);
  initializeLocalWorkspaceStorage(sqlite);
  sqlite.run(
    `INSERT INTO rows(table_key, row_id, fields_json)
		 VALUES (?, ?, ?)`,
    ["notes", "note-1", JSON.stringify({ title: "Existing" })],
  );
  let status = initialStatus;
  let settleCalls = 0;
  const listeners = new Set<(next: WorkspaceSyncStatus) => void>();
  const ownerSync: WorkspaceOwnerSync = {
    get status() {
      return status;
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async settle() {
      return ownerSync.settleThrough(ownerSync.captureAdmissionCut());
    },
    captureRecovery,
    async startFresh() {},
    async whenReady() {},
    captureAdmissionCut,
    async settleThrough(cut) {
      settleCalls += 1;
      return settle(cut);
    },
  };
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      return {
        sqlite,
        sync: ownerSync,
        async [Symbol.asyncDispose]() {
          database.close();
        },
      };
    },
  });
  return {
    runtime,
    getSettleCalls: () => settleCalls,
    setStatus(next: WorkspaceSyncStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

test("open waits for workspace owner acquisition", async () => {
  const database = new Database(":memory:");
  const gate = Promise.withResolvers<void>();
  let settled = false;
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      await gate.promise;
      return {
        sqlite: createBunSqliteAdapter(database),
        async [Symbol.asyncDispose]() {
          database.close();
        },
      };
    },
  });
  try {
    const opening = runtime.open(definition).then((workspace) => {
      settled = true;
      return workspace;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await opening;
    expect(settled).toBe(true);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("failed owner acquisition rejects open and retries cleanly", async () => {
  const database = new Database(":memory:");
  let attempts = 0;
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      attempts += 1;
      if (attempts === 1) throw new Error("owner failed");
      return {
        sqlite: createBunSqliteAdapter(database),
        async [Symbol.asyncDispose]() {
          database.close();
        },
      };
    },
  });
  try {
    await expect(runtime.open(definition)).rejects.toThrow("owner failed");
    await runtime.open(definition);
    expect(attempts).toBe(2);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("openRaw refuses unsafe workspace IDs before owner acquisition", async () => {
  let attempts = 0;
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      attempts += 1;
      throw new Error("must not open");
    },
  });
  try {
    await expect(runtime.openRaw("../outside")).rejects.toThrow(
      "Invalid workspace id",
    );
    await expect(runtime.openRaw("con")).rejects.toThrow(
      "reserved device names",
    );
    expect(attempts).toBe(0);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("local workspace exposes no synchronization capability", async () => {
  const database = new Database(":memory:");
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
      return {
        sqlite: createBunSqliteAdapter(database),
        async [Symbol.asyncDispose]() {
          database.close();
        },
      };
    },
  });
  try {
    const workspace = await runtime.open(definition);
    expect(workspace.sync).toBeNull();
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("synchronized workspace binds one frozen live status capability", async () => {
  const { runtime, setStatus } = setupSynchronizedRuntime();
  try {
    const first = await runtime.open(definition);
    const second = await runtime.open(definition);
    expect(first.sync).toBe(second.sync);
    expect(Object.isFrozen(first.sync)).toBe(true);
    expect(first.sync?.status).toEqual({ phase: "caught-up" });

    const observed: WorkspaceSyncStatus[] = [];
    const unsubscribe = first.sync?.onStatusChange((status) => {
      observed.push(status);
    });
    setStatus({ phase: "pending", reason: "offline" });
    expect(first.sync?.status).toEqual({
      phase: "pending",
      reason: "offline",
    });
    expect(observed).toEqual([{ phase: "pending", reason: "offline" }]);
    unsubscribe?.();
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("workspace settlement returns every owner settlement outcome", async () => {
  const settlements = [
    { outcome: "caught-up" },
    { outcome: "pending", reason: "retrying" },
    { outcome: "upgrade-required" },
    { outcome: "recovery-required", reason: "lineage-mismatch" },
  ] satisfies WorkspaceSyncSettlement[];
  for (const expected of settlements) {
    const { runtime } = setupSynchronizedRuntime({
      settle: async () => expected,
    });
    try {
      const workspace = await runtime.open(definition);
      expect(await workspace.sync?.settle()).toEqual(expected);
    } finally {
      await runtime[Symbol.asyncDispose]();
    }
  }
});

test("recovery capture folds locally durable row documents into the copy", async () => {
  const { runtime } = setupSynchronizedRuntime({
    captureRecovery: async () => ({
      rows: [{ table: "notes", rowId: "note-1", fields: { title: "Existing" } }],
      kv: { theme: "light" },
    }),
  });
  try {
    const workspace = await runtime.open(definition);
    {
      using document = await workspace.tables.notes.document.open("note-1");
      document.get("editor").insert(0, "recover me");
      await document.whenDurable();
    }
    const copy = await workspace.sync?.captureRecovery();
    const captured = copy?.rows[0]?.document;
    expect(captured).toBeInstanceOf(Uint8Array);
    const replay = new Y.Doc();
    Y.applyUpdateV2(replay, captured as Uint8Array);
    expect(replay.get("editor").toString()).toBe("recover me");
    replay.destroy();
    // The capture reads durable state only; a second capture is equivalent.
    const again = await workspace.sync?.captureRecovery();
    expect(again?.rows[0]?.document).toEqual(captured);
    expect(copy?.kv).toEqual({ theme: "light" });
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("recovery capture keeps rows without local document state unmarked", async () => {
  const { runtime } = setupSynchronizedRuntime({
    captureRecovery: async () => ({
      rows: [{ table: "notes", rowId: "note-1", fields: { title: "Existing" } }],
      kv: {},
    }),
  });
  try {
    const workspace = await runtime.open(definition);
    const copy = await workspace.sync?.captureRecovery();
    expect(copy?.rows[0]).not.toContainKey("document");
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("runtime composes row, document, KV, and SQL capabilities", async () => {
  const database = new Database(":memory:");
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
      return {
        sqlite: createBunSqliteAdapter(database),
        async [Symbol.asyncDispose]() {
          database.close();
        },
      };
    },
  });
  try {
    const workspace = await runtime.open(definition);
    const created = await workspace.tables.notes.create({ title: "Draft" });
    expect(
      expectOk(
        await workspace.tables.notes.update(created.id, { archived: true }),
      ),
    ).toEqual({ id: created.id, title: "Draft", archived: true });
    expect((await workspace.tables.notes.list()).rows).toHaveLength(1);

    using document = await workspace.tables.notes.document.open(created.id);
    document.get("editor").insert(0, "hello");
    await document.whenDurable();
    expect(document.get("editor").toString()).toBe("hello");

    expectOk(await workspace.kv.set("theme", "dark"));
    expect(expectOk(await workspace.kv.get("theme"))).toBe("dark");
    const rows = await workspace.sql(
      `SELECT table_key,
              row_id AS id,
              json_extract(fields_json, '$.title') AS title
         FROM records`,
      [],
      Type.Object({
        table_key: Type.String(),
        id: Type.String(),
        title: Type.String(),
      }),
    );
    expect(rows).toEqual([
      { table_key: "notes", id: created.id, title: "Draft" },
    ]);
    await expect(
      workspace.sql("SELECT * FROM rows", [], Type.Any()),
    ).rejects.toThrow("cannot access runtime-private storage");
    await expect(
      workspace.sql("SELECT * FROM 'rows'", [], Type.Any()),
    ).rejects.toThrow("cannot access runtime-private storage");
    database.exec("CREATE TABLE unrelated(secret TEXT)");
    await expect(
      workspace.sql("SELECT * FROM unrelated", [], Type.Any()),
    ).rejects.toThrow("cannot access runtime-private storage");
    expect(
      await workspace.sql(
        `WITH visible AS (SELECT row_id FROM records)
         SELECT row_id AS id FROM visible`,
        [],
        Type.Object({ id: Type.String() }),
      ),
    ).toEqual([{ id: created.id }]);
    expect(
      await workspace.sql(
        "SELECT 1 AS value",
        [],
        Type.Object({ value: Type.Integer() }),
      ),
    ).toEqual([{ value: 1 }]);
    await expect(
      workspace.sql(
        "SELECT records.row_id FROM records JOIN json_each(records.fields_json)",
        [],
        Type.Any(),
      ),
    ).rejects.toThrow("accepts only read-only records queries");
    await expect(
      workspace.sql(
        "SELECT * FROM __epicenter_records_projection",
        [],
        Type.Any(),
      ),
    ).rejects.toThrow("no such table");
    await expect(
      workspace.sql(
        `SELECT json_extract(fields_json, '$.title') AS title FROM records`,
        [],
        Type.Object({ title: Type.Number() }),
      ),
    ).rejects.toThrow("does not satisfy the result schema");

    await workspace.tables.notes.delete(created.id);
    expect(
      expectOk(await workspace.tables.notes.get(created.id)),
    ).toBeUndefined();
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("different lenses share one ID-owned owner, mutations, documents, sync, and lifetime", async () => {
  const database = new Database(":memory:");
  let ownerOpens = 0;
  let ownerDisposals = 0;
  const ownerSync: WorkspaceOwnerSync = {
    status: { phase: "caught-up" },
    onStatusChange: () => () => undefined,
    async settle() {
      return { outcome: "caught-up" };
    },
    captureAdmissionCut: () => 0,
    async settleThrough() {
      return { outcome: "caught-up" };
    },
    async captureRecovery() {
      return null;
    },
    async startFresh() {},
    async whenReady() {},
  };
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      ownerOpens += 1;
      initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
      return {
        sqlite: createBunSqliteAdapter(database),
        sync: ownerSync,
        async [Symbol.asyncDispose]() {
          ownerDisposals += 1;
          database.close();
        },
      };
    },
  });
  try {
    const [first, second, raw] = await Promise.all([
      runtime.open(definition),
      runtime.open(reportingLens),
      runtime.openRaw(definition.id),
    ]);
    expect(ownerOpens).toBe(1);
    expect(first).not.toBe(second);
    expect(first.sync).toBe(second.sync);

    const row = await first.tables.notes.create({
      title: "Shared",
      archived: true,
    });
    expect(expectOk(await second.tables.notes.get(row.id))).toEqual({
      id: row.id,
      title: "Shared",
    });
    expect(raw.read("notes", row.id)).toEqual({
      title: "Shared",
      archived: true,
    });
    expectOk(
      await second.tables.notes.update(row.id, {
        title: "Reported",
        tags: ["shared"],
      }),
    );
    expect(expectOk(await first.tables.notes.get(row.id))).toEqual({
      id: row.id,
      title: "Reported",
      archived: true,
    });
    expect(expectOk(await second.tables.notes.get(row.id))).toEqual({
      id: row.id,
      title: "Reported",
      tags: ["shared"],
    });

    const rawQuery = `SELECT table_key, row_id, fields_json
                        FROM records
                       WHERE table_key = ?`;
    const rawResult = Type.Object({
      table_key: Type.String(),
      row_id: Type.String(),
      fields_json: Type.String(),
    });
    expect(await first.sql(rawQuery, ["notes"], rawResult)).toHaveLength(1);
    const empty = await runtime.open(emptyLens);
    expect(await empty.sql(rawQuery, ["notes"], rawResult)).toHaveLength(1);
    await expect(
      empty.sql("SELECT id FROM notes", [], Type.Object({ id: Type.String() })),
    ).rejects.toThrow("no such table: notes");

    expectOk(await second.kv.set("theme", "blue"));
    expect(expectErr(await first.kv.get("theme")).name).toBe(
      "NonconformingKvValue",
    );

    using firstDocument = await first.tables.notes.document.open(row.id);
    using secondDocument = await second.tables.notes.document.open(row.id);
    firstDocument.get("editor").insert(0, "one owner");
    expect(secondDocument.get("editor").toString()).toBe("one owner");

    expect(expectOk(await second.tables.notes.get(row.id))?.title).toBe("Reported");
    const reopened = await runtime.open(definition);
    expect(reopened).toBe(first);
    expect(ownerOpens).toBe(1);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
  expect(ownerDisposals).toBe(1);
});

test("open accepts a nonconforming lens and reports nonconformance only on read", async () => {
  const database = new Database(":memory:");
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
      return {
        sqlite: createBunSqliteAdapter(database),
        async [Symbol.asyncDispose]() {
          database.close();
        },
      };
    },
  });
  try {
    const writer = await runtime.open(definition);
    const row = await writer.tables.notes.create({ title: "Text" });
    expectOk(await writer.kv.set("theme", "dark"));

    const incompatible = await runtime.open(numericTitleLens);
    const rowError = expectErr(await incompatible.tables.notes.get(row.id));
    if (rowError.name !== "NonconformingRow") {
      throw new Error(`Expected NonconformingRow, got ${rowError.name}`);
    }
    expect(rowError.raw).toEqual({ title: "Text" });
    expect(expectErr(await incompatible.kv.get("theme")).name).toBe(
      "NonconformingKvValue",
    );
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("failed view construction keeps the acquired owner under runtime disposal", async () => {
  const database = new Database(":memory:");
  let ownerOpens = 0;
  let ownerDisposals = 0;
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      ownerOpens += 1;
      initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
      return {
        sqlite: createBunSqliteAdapter(database),
        async [Symbol.asyncDispose]() {
          ownerDisposals += 1;
          database.close();
        },
      };
    },
  });
  try {
    await expect(runtime.open(invalidTableNameLens)).rejects.toThrow(
      "Invalid table name 'bad-name'",
    );
    const recovered = await runtime.open(
      defineWorkspace({
        id: "invalid-view-test",
        tables: {
          notes: defineTable({ fields: { title: field.string() } }),
        },
      }),
    );
    await recovered.tables.notes.create({ title: "Still owned" });
    expect(ownerOpens).toBe(1);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
  expect(ownerDisposals).toBe(1);
});

test("local documents persist updateV2 bytes outside scalar row storage", async () => {
  const database = new Database(":memory:");
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
      return {
        sqlite: createBunSqliteAdapter(database),
        async [Symbol.asyncDispose]() {
          database.close();
        },
      };
    },
  });
  try {
    const workspace = await runtime.open(definition);
    const row = await workspace.tables.notes.create({ title: "Bounded" });
    using document = await workspace.tables.notes.document.open(row.id);
    const editor = document.get("editor");
    editor.insert(0, "local document");
    await document.whenDurable();
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM workspace_document_updates",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM rows")
        .get()?.count,
    ).toBe(1);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("runtime disposal revokes retained row-document handles", async () => {
  const database = new Database(":memory:");
  const runtime = createWorkspaceRuntime({
    async openWorkspaceOwner() {
      initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
      return {
        sqlite: createBunSqliteAdapter(database),
        async [Symbol.asyncDispose]() {
          database.close();
        },
      };
    },
  });
  const workspace = await runtime.open(definition);
  const created = await workspace.tables.notes.create({ title: "Draft" });
  const document = await workspace.tables.notes.document.open(created.id);
  document.get("editor").insert(0, "hello");
  await document.whenDurable();

  await runtime[Symbol.asyncDispose]();

  await expect(workspace.tables.notes.get(created.id)).rejects.toThrow(
    "Workspace runtime is disposed",
  );
  expect(() => document.get("editor")).toThrow("Row document runtime is disposed");
  expect(() => document.transact(() => undefined)).toThrow(
    "Row document runtime is disposed",
  );
});
