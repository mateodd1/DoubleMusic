use crate::error::{ApiError, Result};
use rusqlite::{Connection, OpenFlags, Params, types::ValueRef};
use serde_json::{Map, Value, json};
use std::{
    path::Path,
    sync::{Arc, mpsc},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce(&mut Connection) + Send>;
#[derive(Clone)]
pub struct Store {
    sender: Arc<mpsc::SyncSender<Job>>,
}
impl Store {
    pub fn open(path: &str) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        if path != ":memory:"
            && let Some(dir) = Path::new(path)
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
        }
        if path != ":memory:" && !Path::new(path).exists() {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
        }
        let mut connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        // Reject unknown schema versions before performing any schema initialization.
        let has_metadata: i64 = connection.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='metadata'",
            [],
            |r| r.get(0),
        )?;
        if has_metadata > 0 {
            let version: String = connection.query_row(
                "SELECT value FROM metadata WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )?;
            if version != "1" {
                return Err("CORE_SCHEMA_UNSUPPORTED".into());
            }
        }
        connection.execute_batch(include_str!("schema.sql"))?;
        let (sender, receiver) = mpsc::sync_channel::<Job>(128);
        std::thread::Builder::new()
            .name("doublemusic-sqlite".into())
            .spawn(move || {
                for job in receiver {
                    job(&mut connection);
                }
            })?;
        Ok(Self {
            sender: Arc::new(sender),
        })
    }
    pub async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .try_send(Box::new(move |c| {
                let _ = tx.send(f(c));
            }))
            .map_err(|_| ApiError::new(503, "CORE_BUSY"))?;
        rx.await
            .map_err(|_| ApiError::new(503, "CORE_UNAVAILABLE"))?
    }
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
pub fn rows(c: &Connection, sql: &str, params: impl Params) -> Result<Vec<Value>> {
    let mut stmt = c.prepare_cached(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let values = stmt
        .query_map(params, |r| {
            let mut obj = Map::new();
            for (i, name) in names.iter().enumerate() {
                let val = match r.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                    ValueRef::Blob(_) => Value::Null,
                };
                obj.insert(name.clone(), val);
            }
            Ok(Value::Object(obj))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values)
}
pub fn one(c: &Connection, sql: &str, params: impl Params) -> Result<Option<Value>> {
    Ok(rows(c, sql, params)?.into_iter().next())
}
pub fn rev(c: &Connection, user: &str) -> Result<i64> {
    one(c, "SELECT rev FROM users WHERE id=?", [user])?
        .and_then(|v| v["rev"].as_i64())
        .ok_or_else(ApiError::unauthenticated)
}
pub fn transaction<T>(c: &mut Connection, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let result = f(&tx)?;
    tx.commit()?;
    Ok(result)
}
pub fn change(
    c: &mut Connection,
    user: &str,
    f: impl FnOnce(&Connection) -> Result<(bool, Value)>,
) -> Result<Value> {
    transaction(c, |c| {
        rev(c, user)?;
        let (changed, mut value) = f(c)?;
        if changed {
            c.execute("UPDATE users SET rev=rev+1 WHERE id=?", [user])?;
        }
        value["rev"] = json!(rev(c, user)?);
        Ok(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn new_database_is_private_and_accepts_the_legacy_schema() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state/core.sqlite");
        let store = Store::open(file.to_str().unwrap()).unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(file.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let version = store
            .call(|c| {
                Ok(c.query_row(
                    "SELECT value FROM metadata WHERE key='schema_version'",
                    [],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(version, "1");
    }
    #[test]
    fn future_schema_is_rejected_before_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("future.sqlite");
        let c = Connection::open(&file).unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO metadata VALUES('schema_version','2');").unwrap();
        assert!(Store::open(file.to_str().unwrap()).is_err());
        let tables: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='users'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }
}
