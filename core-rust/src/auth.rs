use crate::{
    db::{self, Store, one, transaction},
    error::{ApiError, Result},
};
use axum::http::HeaderMap;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const TTL: i64 = 30 * 24 * 3600 * 1000;
#[derive(Clone)]
pub struct Auth {
    pub store: Store,
    attempts: Arc<Mutex<HashMap<String, (u32, i64)>>>,
    kdf: Arc<Semaphore>,
    dummy: Arc<String>,
    pub secure: bool,
    pub trust_proxy: bool,
}
#[derive(Clone, Debug)]
pub struct User {
    pub id: String,
    pub username: String,
    pub role: String,
    pub expires_at: i64,
}
impl User {
    pub fn public(&self) -> Value {
        json!({"id":self.id,"username":self.username,"role":self.role})
    }
}
pub fn digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
fn random<const N: usize>() -> [u8; N] {
    let mut b = [0; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}
pub fn valid_username(s: &str, min: usize) -> bool {
    s.len() >= min
        && s.len() <= 64
        && s.bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"_.-".contains(&v))
}
pub fn token(headers: &HeaderMap) -> String {
    fn valid(s: &str) -> bool {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    }
    if let Some(header) = headers.get("authorization") {
        return header
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|s| valid(s))
            .unwrap_or("")
            .into();
    }
    headers
        .get_all("cookie")
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|s| s.split(';'))
        .find_map(|s| {
            s.trim()
                .strip_prefix("doublemusic_session=")
                .filter(|s| valid(s))
        })
        .unwrap_or("")
        .into()
}
pub fn hash_password(password: &str) -> Result<String> {
    if !(8..=1024).contains(&password.encode_utf16().count()) {
        return Err(ApiError::invalid(
            "The password must contain 8 to 1024 characters.",
        ));
    }
    let salt = random::<16>();
    let mut key = [0; 64];
    scrypt::scrypt(
        password.as_bytes(),
        &salt,
        &scrypt::Params::new(14, 8, 1, 64).unwrap(),
        &mut key,
    )
    .map_err(|_| ApiError::new(500, "INTERNAL_ERROR"))?;
    Ok(format!(
        "scrypt$16384$8$1${}${}",
        STANDARD.encode(salt),
        STANDARD.encode(key)
    ))
}
pub fn verify_password(password: &str, hash: &str) -> bool {
    let p: Vec<_> = hash.split('$').collect();
    if p.len() != 6 || p[..4] != ["scrypt", "16384", "8", "1"] {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (STANDARD.decode(p[4]), STANDARD.decode(p[5])) else {
        return false;
    };
    if expected.len() != 64 || salt.len() > 1024 {
        return false;
    }
    let mut actual = [0u8; 64];
    if scrypt::scrypt(
        password.as_bytes(),
        &salt,
        &scrypt::Params::new(14, 8, 1, 64).unwrap(),
        &mut actual,
    )
    .is_err()
    {
        return false;
    }
    bool::from(actual.ct_eq(expected.as_slice()))
}
impl Auth {
    pub fn new(store: Store, secure: bool, trust_proxy: bool) -> Result<Self> {
        Ok(Self {
            store,
            secure,
            trust_proxy,
            attempts: Arc::new(Mutex::new(HashMap::new())),
            kdf: Arc::new(Semaphore::new(8)),
            dummy: Arc::new(hash_password(&URL_SAFE_NO_PAD.encode(random::<32>()))?),
        })
    }
    pub fn permit(&self) -> Result<OwnedSemaphorePermit> {
        self.kdf
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::new(429, "LOGIN_BLOCKED"))
    }
    pub async fn make_hash(&self, password: String) -> Result<String> {
        let permit = self.permit()?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            hash_password(&password)
        })
        .await
        .map_err(|_| ApiError::new(500, "INTERNAL_ERROR"))?
    }
    pub async fn verify(&self, password: String, hash: String) -> Result<bool> {
        let permit = self.permit()?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            verify_password(&password, &hash)
        })
        .await
        .map_err(|_| ApiError::new(500, "INTERNAL_ERROR"))
    }
    pub async fn authenticate(&self, headers: &HeaderMap) -> Result<User> {
        let value = token(headers);
        if value.is_empty() {
            return Err(ApiError::unauthenticated());
        }
        let hashed = digest(&value);
        self.store.call(move |c| {
            let user=one(c,"SELECT u.id,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.expires_at>?",rusqlite::params![hashed,db::now()])?.ok_or_else(ApiError::unauthenticated)?;
            Ok(User {id:user["id"].as_str().unwrap().into(),username:user["username"].as_str().unwrap().into(),role:user["role"].as_str().unwrap().into(),expires_at:user["expires_at"].as_i64().unwrap()})
        }).await
    }
    pub async fn login(&self, body: Value) -> Result<(Value, String)> {
        let username = body["username"].as_str().unwrap_or("").trim().to_string();
        let password = body["password"]
            .as_str()
            .ok_or_else(|| ApiError::invalid("Invalid credentials or transport."))?
            .to_string();
        let transport = match body.get("transport") {
            None | Some(Value::Null) => "cookie",
            Some(Value::String(s)) if s.is_empty() => "cookie",
            Some(Value::Bool(false)) => "cookie",
            Some(Value::String(s)) => s.as_str(),
            _ => return Err(ApiError::invalid("Invalid credentials or transport.")),
        };
        if !valid_username(&username, 1)
            || password.encode_utf16().count() > 1024
            || !["cookie", "bearer"].contains(&transport)
        {
            return Err(ApiError::invalid("Invalid credentials or transport."));
        }
        let key = username.to_lowercase();
        {
            let mut attempts = self.attempts.lock().unwrap();
            let now = db::now();
            attempts.retain(|_, (_, until)| *until > now);
            if attempts.get(&key).is_some_and(|(n, _)| *n >= 8) {
                return Err(ApiError::new(429, "LOGIN_BLOCKED"));
            }
            if attempts.len() >= 4096 && !attempts.contains_key(&key) {
                return Err(ApiError::new(429, "LOGIN_BLOCKED"));
            }
            let count = attempts.entry(key.clone()).or_insert((0, now + 60000));
            count.0 += 1;
        }
        let row = self
            .store
            .call(move |c| {
                one(
                    c,
                    "SELECT id,username,hash,role FROM users WHERE username=?",
                    [username],
                )
            })
            .await?;
        let hash = row
            .as_ref()
            .and_then(|v| v["hash"].as_str())
            .unwrap_or(&self.dummy)
            .to_string();
        let valid = self.verify(password, hash.clone()).await?;
        if !valid || row.is_none() {
            return Err(ApiError::new(401, "INVALID_CREDENTIALS"));
        }
        let row = row.unwrap();
        let bearer = transport == "bearer";
        let new_token = URL_SAFE_NO_PAD.encode(random::<32>());
        let hashed = digest(&new_token);
        let expires = db::now() + TTL;
        let result=self.store.call(move |c|transaction(c,|c| {
            let current=one(c,"SELECT id,username,hash,role FROM users WHERE id=?",[row["id"].as_str().unwrap()])?.ok_or_else(||ApiError::new(401,"INVALID_CREDENTIALS"))?;
            if current["hash"]!=hash {return Err(ApiError::new(401,"INVALID_CREDENTIALS"));}
            let id=current["id"].as_str().unwrap();let now=db::now();
            c.execute("DELETE FROM sessions WHERE expires_at<=?",[now])?;
            c.execute("DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 49)",[id])?;
            c.execute("INSERT INTO sessions VALUES (?,?,?,?)",rusqlite::params![hashed,id,expires,now])?;
            Ok(json!({"user":{"id":current["id"],"username":current["username"],"role":current["role"]},"session":{"expiresAt":expires}}))
        })).await?;
        self.attempts.lock().unwrap().remove(&key);
        let mut result = result;
        if bearer {
            result["session"]["token"] = json!(new_token);
            result["session"]["tokenType"] = json!("Bearer");
        }
        Ok((result, new_token))
    }
    pub fn cookie(&self, headers: &HeaderMap, value: &str, expires: i64) -> String {
        let secure = self.secure
            || (self.trust_proxy
                && headers
                    .get("x-forwarded-proto")
                    .is_some_and(|v| v == "https"));
        format!(
            "doublemusic_session={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
            if value.is_empty() {
                0
            } else {
                ((expires - db::now()) / 1000).max(0)
            },
            if secure { "; Secure" } else { "" }
        )
    }
    pub async fn logout(&self, headers: &HeaderMap) -> Result<Value> {
        let hashed = digest(&token(headers));
        self.store
            .call(move |c| {
                c.execute("DELETE FROM sessions WHERE digest=?", [hashed])?;
                Ok(json!({"ok":true}))
            })
            .await
    }
    pub async fn password(&self, user: User, body: Value) -> Result<Value> {
        let id = user.id;
        let old = self
            .store
            .call({
                let id = id.clone();
                move |c| {
                    one(c, "SELECT hash FROM users WHERE id=?", [id])?
                        .ok_or_else(ApiError::unauthenticated)
                }
            })
            .await?["hash"]
            .as_str()
            .unwrap()
            .to_string();
        if !self
            .verify(
                body["currentPassword"].as_str().unwrap_or("").into(),
                old.clone(),
            )
            .await?
        {
            return Err(ApiError::new(403, "INVALID_PASSWORD"));
        }
        let hash = self
            .make_hash(
                body["newPassword"]
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("Invalid password."))?
                    .into(),
            )
            .await?;
        self.store
            .call(move |c| {
                transaction(c, |c| {
                    let current = one(c, "SELECT hash FROM users WHERE id=?", [&id])?
                        .ok_or_else(|| ApiError::new(409, "REVISION_CONFLICT"))?;
                    if current["hash"] != old {
                        return Err(ApiError::new(409, "REVISION_CONFLICT"));
                    }
                    c.execute(
                        "UPDATE users SET hash=? WHERE id=?",
                        rusqlite::params![hash, id],
                    )?;
                    c.execute("DELETE FROM sessions WHERE user_id=?", [id])?;
                    Ok(json!({"ok":true,"loginRequired":true}))
                })
            })
            .await
    }
}
