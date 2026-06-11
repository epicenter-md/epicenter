//! The read-only SQLite mirror for a vault folder.
//!
//! `matter.sqlite` sits NEXT TO `matter.json` as a derived, disposable mirror of the
//! folder's readable rows (valid rows AND drafts in progress, a missing cell stored as
//! NULL), so a coding agent (or an in-app SQL console) can run arbitrary SQL over the
//! typed folder, including triaging unfinished drafts. The JS projector
//! (`core/sqlite.ts`) builds all the SQL
//! TEXT (the schema script + the insert, quoting and placeholders included) and the
//! row tuples; Rust only opens the db, runs the schema script, and parameter-binds
//! each row. It never learns what a column or a kind is, the same faithful role
//! `entry.rs` and `watch.rs` play for writes and reads.
//!
//! The rebuild is a full DROP + CREATE + INSERT in one transaction, so it is
//! disposable: delete the file, reopen the folder, get an identical table. It is
//! driven per settled watcher batch from `vault.svelte.ts`.

use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::time::Duration;

/// Open `<path>/matter.sqlite` with the given access flags. The single opener both
/// commands share, so the ONLY difference between a rebuild and a query is the flag:
/// `OpenFlags::default()` (read-write, create) for `write_mirror` versus
/// `SQLITE_OPEN_READ_ONLY` for `query_mirror`. `busy_timeout` lets either wait out an
/// in-flight rebuild instead of failing with SQLITE_BUSY.
fn open_mirror(path: &str, flags: OpenFlags) -> Result<Connection, String> {
    let db = Path::new(path).join("matter.sqlite");
    let conn = Connection::open_with_flags(&db, flags).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Turn one JSON arg into a SQLite-bindable value. The projector emits strings, numbers,
/// and null (a missing cell binds NULL; booleans are already 0/1, arrays are JSON text);
/// bool is mapped defensively too so a future projector change cannot panic here.
fn to_sql(value: &serde_json::Value) -> Value {
    use serde_json::Value as J;
    match value {
        J::String(s) => Value::Text(s.clone()),
        J::Number(n) => n
            .as_i64()
            .map(Value::Integer)
            .unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
        J::Bool(b) => Value::Integer(*b as i64),
        J::Null => Value::Null,
        other => Value::Text(other.to_string()),
    }
}

/// Rebuild `<path>/matter.sqlite` from the projected rows. `schema` (a `DROP` + `CREATE`
/// script) and `insert` are the SQL the JS projector built; `rows` is one tuple per
/// readable row, positional against the insert's columns. Full drop-and-recreate in one
/// transaction, so the file is disposable.
#[tauri::command]
pub fn write_mirror(
    path: String,
    schema: String,
    insert: String,
    rows: Vec<Vec<serde_json::Value>>,
) -> Result<(), String> {
    // Reconciles fire per watcher batch and each opens its own connection, so two can
    // overlap on a large folder (or with an agent reading). The shared `busy_timeout`
    // waits for the lock instead of failing fast with SQLITE_BUSY; the rebuild is a full
    // drop-and-recreate, so a brief wait is cheaper than a lost rebuild.
    let mut conn = open_mirror(&path, OpenFlags::default())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // execute_batch runs the multi-statement DROP + CREATE script (no params).
    tx.execute_batch(&schema).map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare(&insert).map_err(|e| e.to_string())?;
        for row in &rows {
            let params: Vec<Value> = row.iter().map(to_sql).collect();
            stmt.execute(rusqlite::params_from_iter(params))
                .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// One result set from `query_mirror`: the column names and the rows (each a positional
/// list of JSON-encoded cell values). Generic and schema-blind, like the rest of this
/// module: Rust runs the SQL and hands back values, it never interprets them.
#[derive(Debug, serde::Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

/// Turn one SQLite cell into JSON for the frontend (the inverse of `to_sql`). matter
/// never projects blobs, so a blob maps to null defensively rather than dragging in a
/// base64 dependency.
fn from_sql(value: rusqlite::types::ValueRef) -> serde_json::Value {
    use rusqlite::types::ValueRef as V;
    use serde_json::Value as J;
    match value {
        V::Null => J::Null,
        V::Integer(i) => J::Number(i.into()),
        V::Real(f) => serde_json::Number::from_f64(f).map(J::Number).unwrap_or(J::Null),
        V::Text(s) => J::String(String::from_utf8_lossy(s).into_owned()),
        V::Blob(_) => J::Null,
    }
}

/// Run a READ-ONLY query against `<path>/matter.sqlite` and return the rows, up to
/// `limit`, or every match when `limit` is `None`. The connection is opened read-only,
/// so a query can never mutate the disposable mirror (a write would be lost on the next
/// reconcile anyway). The SQL is the caller's (the user's own query against their own
/// local file), so Rust stays schema-blind: it runs the statement and hands back column
/// names and JSON values, nothing interpreted.
#[tauri::command]
pub fn query_mirror(
    path: String,
    sql: String,
    limit: Option<usize>,
) -> Result<QueryResult, String> {
    let conn = open_mirror(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let col_count = columns.len();

    let mut out: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if let Some(limit) = limit {
            if out.len() >= limit {
                break;
            }
        }
        let mut record = Vec::with_capacity(col_count);
        for i in 0..col_count {
            record.push(from_sql(row.get_ref(i).map_err(|e| e.to_string())?));
        }
        out.push(record);
    }

    Ok(QueryResult {
        columns,
        rows: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A unique scratch dir under the OS temp dir (mirrors `entry.rs`).
    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "matter-mirror-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SCHEMA: &str = r#"DROP TABLE IF EXISTS "drafts";
CREATE TABLE "drafts" ("path" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "count" INTEGER NOT NULL, "_extra" TEXT NOT NULL)"#;
    const INSERT: &str =
        r#"INSERT INTO "drafts" ("path", "title", "count", "_extra") VALUES (?, ?, ?, ?)"#;

    fn count(dir: &std::path::Path) -> i64 {
        Connection::open(dir.join("matter.sqlite"))
            .unwrap()
            .query_row(r#"SELECT COUNT(*) FROM "drafts""#, [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn writes_the_db_next_to_matter_json_with_typed_values() {
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();
        let rows = vec![
            vec![json!("a.md"), json!("Hello"), json!(3), json!("{}")],
            vec![json!("b.md"), json!("World"), json!(5), json!(r#"{"k":1}"#)],
        ];

        write_mirror(path, SCHEMA.into(), INSERT.into(), rows).unwrap();

        // The file lands in the given folder (where matter.json lives), not elsewhere.
        assert!(dir.join("matter.sqlite").exists());

        let conn = Connection::open(dir.join("matter.sqlite")).unwrap();
        let (title, n): (String, i64) = conn
            .query_row(
                r#"SELECT "title", "count" FROM "drafts" WHERE "path" = ?"#,
                ["a.md"],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Hello");
        assert_eq!(n, 3); // INTEGER stored and read back as a number
        assert_eq!(count(&dir), 2);
    }

    #[test]
    fn rebuild_is_a_full_drop_and_recreate() {
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();

        write_mirror(
            path.clone(),
            SCHEMA.into(),
            INSERT.into(),
            vec![
                vec![json!("a.md"), json!("A"), json!(1), json!("{}")],
                vec![json!("b.md"), json!("B"), json!(2), json!("{}")],
            ],
        )
        .unwrap();
        assert_eq!(count(&dir), 2);

        // A second write with one row replaces the table wholesale (disposable).
        write_mirror(
            path,
            SCHEMA.into(),
            INSERT.into(),
            vec![vec![json!("only.md"), json!("Solo"), json!(9), json!("{}")]],
        )
        .unwrap();
        assert_eq!(count(&dir), 1);
    }

    #[test]
    fn query_mirror_reads_rows_limits_and_rejects_writes() {
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();
        write_mirror(
            path.clone(),
            SCHEMA.into(),
            INSERT.into(),
            vec![
                vec![json!("a.md"), json!("Hello"), json!(3), json!("{}")],
                vec![json!("b.md"), json!("World"), json!(5), json!("{}")],
            ],
        )
        .unwrap();

        let result = query_mirror(
            path.clone(),
            r#"SELECT "path", "count" FROM "drafts" WHERE "count" > 3"#.into(),
            None,
        )
        .unwrap();
        assert_eq!(result.columns, vec!["path".to_string(), "count".to_string()]);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], json!("b.md"));
        assert_eq!(result.rows[0][1], json!(5));

        // `Some(limit)` caps the row count; `None` returns every match.
        let limited =
            query_mirror(path.clone(), r#"SELECT "path" FROM "drafts""#.into(), Some(1)).unwrap();
        assert_eq!(limited.rows.len(), 1);
        let unbounded =
            query_mirror(path.clone(), r#"SELECT "path" FROM "drafts""#.into(), None).unwrap();
        assert_eq!(unbounded.rows.len(), 2);

        // The connection is read-only, so a write is rejected, never a silent mutation.
        let err = query_mirror(path, r#"DELETE FROM "drafts""#.into(), None).unwrap_err();
        assert!(err.to_lowercase().contains("readonly"));
    }

    #[test]
    fn binds_null_for_a_missing_cell() {
        // The projector emits null for a NEEDS_VALUE cell (a draft in progress) against a
        // nullable column; it must bind as SQL NULL so `IS NULL` finds the draft.
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();
        let schema = "DROP TABLE IF EXISTS \"drafts\";\nCREATE TABLE \"drafts\" (\"path\" TEXT PRIMARY KEY, \"title\" TEXT)";
        let insert = r#"INSERT INTO "drafts" ("path", "title") VALUES (?, ?)"#;
        write_mirror(
            path.clone(),
            schema.into(),
            insert.into(),
            vec![vec![json!("draft.md"), json!(null)]],
        )
        .unwrap();

        let result = query_mirror(
            path,
            r#"SELECT "path" FROM "drafts" WHERE "title" IS NULL"#.into(),
            None,
        )
        .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], json!("draft.md"));
    }
}
