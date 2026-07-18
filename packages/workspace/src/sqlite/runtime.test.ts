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
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { field } from "@epicenter/field";
import { createBunSqliteAdapter } from "@epicenter/sqlite/bun";
import { Type } from "typebox";
import { expectOk } from "wellcrafted/testing";
import type {
  WorkspaceOwnerSync,
  WorkspaceSyncSettlement,
  WorkspaceSyncStatus,
} from "./canonical-sync-supervisor.js";
import { defineTable } from "./lens-definition.js";
import { initializeLocalWorkspaceStorage } from "./local-workspace-storage.js";
import { createWorkspaceRuntime } from "./runtime.js";
import { defineWorkspace } from "./runtime-definition.js";

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

function setupSynchronizedRuntime({
  initialStatus = { phase: "caught-up" },
  captureAdmissionCut = () => 0,
  settle = async (_cut: number) => ({ outcome: "caught-up" }),
}: {
  initialStatus?: WorkspaceSyncStatus;
  captureAdmissionCut?: () => number;
  settle?: (cut: number) => Promise<WorkspaceSyncSettlement>;
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
    async captureRecovery() {
      return null;
    },
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
      "SELECT id, title FROM notes",
      [],
      Type.Object({ id: Type.String(), title: Type.String() }),
    );
    expect(rows).toEqual([{ id: created.id, title: "Draft" }]);

    await workspace.tables.notes.delete(created.id);
    expect(
      expectOk(await workspace.tables.notes.get(created.id)),
    ).toBeUndefined();
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("runtime binds one definition identity per workspace id", async () => {
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
    await runtime.open(definition);
    await expect(
      runtime.open(
        defineWorkspace({
          id: "runtime-test",
          tables: definition.tables,
          kv: definition.kv,
        }),
      ),
    ).rejects.toThrow("already bound to another definition");
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
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

  expect(() => document.get("editor")).toThrow("Row document runtime is disposed");
  expect(() => document.transact(() => undefined)).toThrow(
    "Row document runtime is disposed",
  );
});
