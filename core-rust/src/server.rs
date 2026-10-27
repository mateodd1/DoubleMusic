use crate::{
    auth::{self, Auth, User},
    bridge::Bridge,
    connect::Connect,
    db::{self, Store, one, rows, transaction},
    error::{ApiError, Result},
    library,
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{FromRequestParts, Request, State, ws::WebSocketUpgrade},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};

#[derive(Clone)]
pub struct Config {
    pub listen: String,
    pub database: String,
    pub catalog_origin: String,
    pub public_url: String,
    pub secure_cookies: bool,
    pub trust_proxy: bool,
    pub connect_origins: Vec<String>,
}
impl Config {
    pub fn from_env() -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let public_url = std::env::var("PUBLIC_URL").unwrap_or_default();
        let public_url = if public_url.is_empty() {
            public_url
        } else {
            let u = url::Url::parse(&public_url)?;
            if !["http", "https"].contains(&u.scheme())
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || u.path() != "/"
                || u.query().is_some()
                || u.fragment().is_some()
            {
                return Err(
                    "PUBLIC_URL must be an HTTP(S) origin without a path or credentials".into(),
                );
            }
            u.origin().ascii_serialization()
        };
        let host = std::env::var("HOST").unwrap_or("0.0.0.0".into());
        let port = std::env::var("PORT")
            .unwrap_or("3000".into())
            .parse::<u16>()?;
        if port == 0 {
            return Err("Invalid PORT".into());
        }
        Ok(Self {
            listen: std::env::var("CORE_LISTEN").unwrap_or(format!("{host}:{port}")),
            database: std::env::var("CORE_DB").unwrap_or_else(|_| {
                std::path::Path::new(&std::env::var("DATA_DIR").unwrap_or("./data".into()))
                    .join("core.sqlite")
                    .to_string_lossy()
                    .into_owned()
            }),
            catalog_origin: std::env::var("CATALOG_ORIGIN")
                .unwrap_or("http://127.0.0.1:3001".into()),
            connect_origins: std::env::var("ALLOWED_ORIGINS")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or(public_url.clone())
                .split(',')
                .filter(|v| !v.trim().is_empty())
                .map(|v| url::Url::parse(v.trim()).map(|u| u.origin().ascii_serialization()))
                .collect::<std::result::Result<Vec<_>, _>>()?,
            public_url,
            secure_cookies: std::env::var("SECURE_COOKIES").is_ok_and(|s| s == "true"),
            trust_proxy: std::env::var("TRUST_PROXY").is_ok_and(|s| s == "true"),
        })
    }
}
struct App {
    store: Store,
    auth: Auth,
    bridge: Bridge,
    connect: Connect,
    public_url: String,
}
pub fn application(
    config: Config,
) -> std::result::Result<(Router, Connect), Box<dyn std::error::Error>> {
    let store = Store::open(&config.database)?;
    let auth = Auth::new(store.clone(), config.secure_cookies, config.trust_proxy)
        .map_err(|e| format!("Auth initialization: {}", e.code))?;
    let connect = Connect::new(&auth, config.connect_origins, config.public_url.clone());
    let state = Arc::new(App {
        auth,
        store,
        bridge: Bridge::new(config.catalog_origin)?,
        connect: connect.clone(),
        public_url: config.public_url,
    });
    Ok((Router::new().fallback(entry).with_state(state), connect))
}
async fn entry(State(state): State<Arc<App>>, request: Request) -> Response {
    let request_id = uuid::Uuid::new_v4().to_string();
    let native = is_native(request.uri().path());
    let mut response = match dispatch(state.clone(), request).await {
        Ok(r) => r,
        Err(mut e) => {
            if e.status >= 500 {
                eprintln!("Rust core {request_id}: {}", e.code);
            }
            let mut details = *e.details.take().unwrap_or_else(|| Box::new(json!({})));
            details["requestId"] = json!(request_id);
            e.details = Some(Box::new(details));
            e.into_response()
        }
    };
    if native
        && response
            .headers()
            .get("content-type")
            .is_some_and(|h| h.as_bytes().starts_with(b"application/json"))
    {
        let (parts, body) = response.into_parts();
        response = match to_bytes(body, 16 * 1024 * 1024).await {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(mut value) => {
                    artwork_urls(&mut value, &state.public_url, false);
                    Response::from_parts(parts, axum::body::Body::from(value.to_string()))
                }
                Err(_) => Response::from_parts(parts, axum::body::Body::from(bytes)),
            },
            Err(_) => ApiError::new(500, "INTERNAL_ERROR").into_response(),
        };
        response.headers_mut().remove("content-length");
    }
    let h = response.headers_mut();
    h.insert("x-request-id", request_id.parse().unwrap());
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert(
        "x-core-runtime",
        if native { "rust" } else { "rust-catalog" }
            .parse()
            .unwrap(),
    );
    for (k, v) in [
        ("cache-control", "private, no-store"),
        ("cdn-cache-control", "no-store"),
        ("cloudflare-cdn-cache-control", "no-store"),
    ] {
        if !h.contains_key(k) {
            h.insert(k, v.parse().unwrap());
        }
    }
    response
}
fn is_native(path: &str) -> bool {
    matches!(
        path,
        "/api/v1/connect"
            | "/health"
            | "/api/v1"
            | "/api/v1/"
            | "/api/v1/auth/login"
            | "/api/v1/auth/logout"
            | "/api/v1/auth/me"
            | "/api/v1/auth/password"
            | "/api/v1/library"
            | "/api/v1/library/playlists"
            | "/api/v1/library/import"
            | "/api/v1/following"
    ) || path.starts_with("/api/v1/admin/users")
        || path.starts_with("/api/v1/library/favorites/")
        || path.starts_with("/api/v1/library/playlists/")
        || path.starts_with("/api/v1/library/saved-albums/")
        || path.starts_with("/api/v1/library/saved-playlists/")
        || path.starts_with("/api/v1/following/")
}
fn methods(method: &Method, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&method.as_str()) {
        return Ok(());
    }
    let mut e = ApiError::new(405, "METHOD_NOT_ALLOWED");
    e.details = Some(Box::new(json!({"allowed":allowed})));
    Err(e)
}
async fn body(request: Request, limit: usize) -> Result<Value> {
    let ct = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !ct.eq_ignore_ascii_case("application/json") {
        return Err(ApiError::invalid(
            "Content-Type: application/json is required.",
        ));
    }
    if request
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|n| n > limit)
    {
        return Err(ApiError::new(413, "TOO_LARGE"));
    }
    let b = to_bytes(request.into_body(), limit)
        .await
        .map_err(|_| ApiError::new(413, "TOO_LARGE"))?;
    let v: Value = serde_json::from_slice(&b)
        .map_err(|_| ApiError::invalid("Expected a valid JSON object."))?;
    if !v.is_object() {
        return Err(ApiError::invalid("Expected a valid JSON object."));
    }
    Ok(v)
}
fn response(value: Value) -> Response {
    Json(value).into_response()
}
fn decode(segment: &str) -> Result<String> {
    let b = segment.as_bytes();
    let mut i = 0;
    let mut out = vec![];
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                return Err(ApiError::new(400, "INVALID_PATH"));
            }
            let h = |b: u8| (b as char).to_digit(16).map(|v| v as u8);
            out.push(
                h(b[i + 1])
                    .zip(h(b[i + 2]))
                    .map(|(a, b)| a * 16 + b)
                    .ok_or_else(|| ApiError::new(400, "INVALID_PATH"))?,
            );
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ApiError::new(400, "INVALID_PATH"))
}
async fn dispatch(state: Arc<App>, request: Request) -> Result<Response> {
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    let headers = request.headers().clone();
    if path == "/api/v1/connect"
        && headers
            .get("upgrade")
            .is_some_and(|s| s.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        if request.uri().query().is_some() {
            return Err(ApiError::missing());
        }
        let (mut parts, _) = request.into_parts();
        let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &())
            .await
            .map_err(|_| ApiError::new(400, "INVALID_WEBSOCKET"))?;
        return state.connect.upgrade(&state.auth, headers, upgrade).await;
    }
    if path == "/api/v1/connect" {
        return Err(ApiError::new(426, "WEBSOCKET_REQUIRED"));
    }
    if !is_native(&path) {
        return state.bridge.proxy(request).await;
    }
    if path == "/health" {
        methods(&method, &["GET"])?;
        state
            .store
            .call(|c| {
                c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))?;
                Ok(())
            })
            .await?;
        // Compatibility services are still required; readiness must include them.
        state.bridge.json("/health", "").await?;
        return Ok(response(json!({"status":"ok","apiVersion":1})));
    }
    if path == "/api/v1" || path == "/api/v1/" {
        methods(&method, &["GET"])?;
        let mut discovery = state.bridge.json("/api/v1", "").await?;
        discovery["version"] = json!(env!("CARGO_PKG_VERSION"));
        discovery["runtime"] = json!({"core":"rust","catalog":"node"});
        return Ok(response(discovery));
    }
    if path == "/api/v1/auth/login" {
        methods(&method, &["POST"])?;
        let b = body(request, 4096).await?;
        let cookie = b["transport"] != "bearer";
        let (result, token) = state.auth.login(b).await?;
        let expires = result["session"]["expiresAt"].as_i64().unwrap();
        let mut res = response(result);
        if cookie {
            res.headers_mut().insert(
                "set-cookie",
                state
                    .auth
                    .cookie(&headers, &token, expires)
                    .parse()
                    .unwrap(),
            );
        }
        return Ok(res);
    }
    if path == "/api/v1/auth/logout" {
        methods(&method, &["POST"])?;
        let mut res = response(state.auth.logout(&headers).await?);
        res.headers_mut().insert(
            "set-cookie",
            state.auth.cookie(&headers, "", 0).parse().unwrap(),
        );
        return Ok(res);
    }
    let user = state.auth.authenticate(&headers).await?;
    let id = user.id.clone();
    let token = auth::token(&headers);
    if path == "/api/v1/auth/me" {
        methods(&method, &["GET"])?;
        let result = json!({"user":user.public(),"session":{"expiresAt":user.expires_at}});
        return Ok(response(result));
    }
    if path == "/api/v1/auth/password" {
        methods(&method, &["PUT"])?;
        let b = body(request, 4096).await?;
        let mut res = response(state.auth.password(user, b).await?);
        res.headers_mut().insert(
            "set-cookie",
            state.auth.cookie(&headers, "", 0).parse().unwrap(),
        );
        return Ok(res);
    }
    if path == "/api/v1/admin/users" || path.starts_with("/api/v1/admin/users/") {
        return admin(state, user, request).await;
    }
    if path == "/api/v1/library" {
        methods(&method, &["GET"])?;
        let params: HashMap<String, String> =
            url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                .into_owned()
                .collect();
        if params
            .get("rev")
            .is_some_and(|v| v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(ApiError::invalid("rev must be a nonnegative integer."));
        }
        let mut data = state
            .store
            .call(move |c| {
                let tx = c.transaction()?;
                let data = library::library(&tx, &id)?;
                tx.commit()?;
                Ok(data)
            })
            .await?;
        let has_saved = !data["savedPlaylists"].as_array().unwrap().is_empty();
        if has_saved {
            for batch in data["savedPlaylists"].as_array_mut().unwrap().chunks_mut(8) {
                let current = futures_util::future::join_all(batch.iter().map(|p| {
                    let path = format!(
                        "/api/v1/catalog/playlists/{}",
                        encode(p["id"].as_str().unwrap())
                    );
                    let bridge = &state.bridge;
                    let token = &token;
                    async move { bridge.json(&path, token).await }
                }))
                .await;
                for (p, current) in batch.iter_mut().zip(current) {
                    match current {
                        Ok(mut current) => {
                            let count = current["tracks"].as_array().map_or(0, Vec::len);
                            current.as_object_mut().unwrap().remove("tracks");
                            p.as_object_mut()
                                .unwrap()
                                .extend(current.as_object().unwrap().clone());
                            p["trackCount"] = json!(count);
                            p["available"] = json!(true);
                        }
                        Err(_) => p["available"] = json!(false),
                    }
                }
            }
        }
        artwork_urls(&mut data, &state.public_url, true);
        let catalog_rev = format!(
            "{:x}",
            Sha256::digest(data["savedPlaylists"].to_string().as_bytes())
        )[..16]
            .to_string();
        let etag = format!("\"{}:{}:{}\"", user.id, data["rev"], catalog_rev);
        let unchanged = params.get("rev").and_then(|n| n.parse::<i64>().ok())
            == data["rev"].as_i64()
            && (!has_saved || params.get("catalogRev") == Some(&catalog_rev));
        data["catalogRev"] = json!(catalog_rev);
        let mut res = if unchanged {
            StatusCode::NOT_MODIFIED.into_response()
        } else {
            response(data)
        };
        res.headers_mut().insert("etag", etag.parse().unwrap());
        return Ok(res);
    }
    if path == "/api/v1/library/import" {
        methods(&method, &["POST"])?;
        let mut b = body(request, 5 * 1024 * 1024).await?;
        canonical_import(&state, &token, &mut b).await?;
        return Ok(response(
            state
                .store
                .call(move |c| library::import_library(c, &id, b))
                .await?,
        ));
    }
    if path == "/api/v1/library/playlists" {
        methods(&method, &["POST"])?;
        let mut b = body(request, 5 * 1024 * 1024).await?;
        canonical_playlist(&state, &token, &mut b).await?;
        let mut res = response(
            state
                .store
                .call(move |c| library::create_playlist(c, &id, b))
                .await?,
        );
        *res.status_mut() = StatusCode::CREATED;
        return Ok(res);
    }
    if let Some(encoded) = path
        .strip_prefix("/api/v1/library/favorites/")
        .filter(|s| !s.is_empty() && !s.contains('/'))
    {
        methods(&method, &["PUT", "DELETE"])?;
        let target = decode(encoded)?;
        let delete = method == Method::DELETE;
        let b = if delete {
            json!({})
        } else {
            let mut b = body(request, 256 * 1024).await?;
            if b["track"]["id"] != target {
                return Err(ApiError::invalid("track.id must match the route."));
            }
            b["track"] = canonical_track(&state, &token, &b["track"]).await?;
            b
        };
        return Ok(response(
            state
                .store
                .call(move |c| library::favorite(c, &id, &target, b, delete))
                .await?,
        ));
    }
    if let Some(rest) = path.strip_prefix("/api/v1/library/playlists/") {
        let parts: Vec<_> = rest.split('/').collect();
        let p = parts[0].to_string();
        if p.len() < 2
            || p.len() > 64
            || !p.starts_with('u')
            || !p
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || parts.len() > 3
        {
            return Err(ApiError::missing());
        }
        let action = parts.get(1).copied().unwrap_or("").to_string();
        let track = parts.get(2).map(|s| decode(s)).transpose()?;
        match (action.as_str(), track.is_some()) {
            ("", false) => methods(&method, &["GET", "PATCH", "DELETE"])?,
            ("tracks", false) => methods(&method, &["POST"])?,
            ("tracks", true) => methods(&method, &["DELETE"])?,
            ("order", false) => methods(&method, &["PUT"])?,
            _ => return Err(ApiError::missing()),
        }
        let mut b = if method == Method::GET || method == Method::DELETE {
            json!({})
        } else {
            let limit = if action == "tracks" {
                5 * 1024 * 1024
            } else if action == "order" {
                256 * 1024
            } else {
                4096
            };
            body(request, limit).await?
        };
        if action == "tracks" && method == Method::POST {
            b["tracks"] = canonical_tracks(&state, &token, &b["tracks"]).await?;
        }
        return Ok(response(
            state
                .store
                .call(move |c| {
                    library::playlist_action(
                        c,
                        &id,
                        &p,
                        &action,
                        track.as_deref(),
                        method.as_str(),
                        b,
                    )
                })
                .await?,
        ));
    }
    if path == "/api/v1/following" {
        methods(&method, &["GET"])?;
        return Ok(response(
            state
                .store
                .call(move |c| {
                    Ok(json!({"rev":db::rev(c,&id)?,"items":library::following(c,&id)?}))
                })
                .await?,
        ));
    }
    if let Some(encoded) = path
        .strip_prefix("/api/v1/following/")
        .filter(|s| !s.is_empty() && !s.contains('/'))
    {
        methods(&method, &["PUT", "DELETE"])?;
        let target = decode(encoded)?;
        let delete = method == Method::DELETE;
        let b = if delete {
            json!({})
        } else {
            body(request, 8192).await?;
            let mut artist = state
                .bridge
                .json(&format!("/api/v1/catalog/artists/{encoded}"), &token)
                .await?["artist"]
                .clone();
            artwork_urls(&mut artist, &state.public_url, true);
            artist
        };
        return Ok(response(
            state
                .store
                .call(move |c| library::follow(c, &id, &target, b, delete))
                .await?,
        ));
    }
    for (prefix, kind) in [
        ("/api/v1/library/saved-albums/", "albums"),
        ("/api/v1/library/saved-playlists/", "playlists"),
    ] {
        if let Some(encoded) = path
            .strip_prefix(prefix)
            .filter(|s| !s.is_empty() && !s.contains('/'))
        {
            methods(&method, &["PUT", "DELETE"])?;
            let target = decode(encoded)?;
            library::reference(&target)?;
            if method == Method::DELETE {
                return Ok(response(
                    state
                        .store
                        .call(move |c| library::save(c, &id, &target, kind, None))
                        .await?,
                ));
            }
            if headers.contains_key("content-length") || headers.contains_key("transfer-encoding") {
                body(request, 1024).await?;
            }
            let already = state
                .store
                .call({
                    let id = id.clone();
                    let target = target.clone();
                    move |c| {
                        let sql = if kind == "albums" {
                            "SELECT 1 FROM saved_albums WHERE user_id=? AND album_id=?"
                        } else {
                            "SELECT 1 FROM saved_playlists WHERE user_id=? AND playlist_id=?"
                        };
                        Ok(one(c, sql, rusqlite::params![id, target])?.is_some())
                    }
                })
                .await?;
            if already {
                return Ok(response(
                    state
                        .store
                        .call(move |c| Ok(json!({"rev":db::rev(c,&id)?})))
                        .await?,
                ));
            }
            let data = state
                .bridge
                .json(&format!("/api/v1/catalog/{kind}/{encoded}"), &token)
                .await?;
            if data["id"] != target || data["title"].as_str().is_none_or(|t| t.trim().is_empty()) {
                return Err(ApiError::new(502, "PROVIDER_INVALID_RESPONSE"));
            }
            let mut snapshot = json!({});
            let fields = if kind == "albums" {
                vec!["id", "title", "artist", "artistId", "year", "coverUrl"]
            } else {
                vec![
                    "id",
                    "title",
                    "coverUrl",
                    "sourceTrackCount",
                    "unavailableTrackCount",
                    "indexedAt",
                    "collection",
                ]
            };
            for field in fields {
                if let Some(value) = data.get(field) {
                    snapshot[field] = value.clone();
                }
            }
            snapshot["trackCount"] = json!(
                data["tracks"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or_else(|| data["trackCount"].as_u64().unwrap_or(0) as usize)
            );
            artwork_urls(&mut snapshot, &state.public_url, true);
            return Ok(response(
                state
                    .store
                    .call(move |c| library::save(c, &id, &target, kind, Some(snapshot)))
                    .await?,
            ));
        }
    }
    Err(ApiError::missing())
}
fn encode(id: &str) -> String {
    url::form_urlencoded::byte_serialize(id.as_bytes()).collect()
}
fn artwork_urls(value: &mut Value, public_url: &str, normalize: bool) {
    match value {
        Value::Array(items) => {
            for item in items {
                artwork_urls(item, public_url, normalize);
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                if ["coverUrl", "coverUrlHi", "imageUrl", "audioUrl"].contains(&key.as_str()) {
                    if let Some(s) = item.as_str() {
                        if normalize
                            && !public_url.is_empty()
                            && s.starts_with(&format!("{public_url}/api/v1/"))
                        {
                            *item = json!(&s[public_url.len()..]);
                        } else if !normalize && s.starts_with("/api/v1/") {
                            *item = json!(format!("{public_url}{s}"));
                        }
                    }
                } else {
                    artwork_urls(item, public_url, normalize);
                }
            }
        }
        _ => {}
    }
}
async fn canonical_track(state: &App, token: &str, raw: &Value) -> Result<Value> {
    let id = raw["id"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("A track ID is required."))?;
    library::reference(id)?;
    let mut value = state
        .bridge
        .json(&format!("/api/v1/catalog/tracks/{}", encode(id)), token)
        .await?;
    if value["id"] != id {
        return Err(ApiError::new(502, "PROVIDER_INVALID_RESPONSE"));
    }
    artwork_urls(&mut value, &state.public_url, true);
    Ok(value)
}
async fn canonical_tracks(state: &App, token: &str, raw: &Value) -> Result<Value> {
    let items = raw
        .as_array()
        .ok_or_else(|| ApiError::invalid("tracks/favorites must be an array."))?;
    let mut out = Vec::with_capacity(items.len());
    // Bound catalog requests while preserving order and failing before any DB mutation.
    for batch in items.chunks(8) {
        out.extend(
            futures_util::future::try_join_all(
                batch.iter().map(|v| canonical_track(state, token, v)),
            )
            .await?,
        );
    }
    Ok(json!(out))
}
async fn canonical_playlist(state: &App, token: &str, body: &mut Value) -> Result<()> {
    let tracks = body.get("tracks").cloned().unwrap_or(json!([]));
    body["tracks"] = canonical_tracks(state, token, &tracks).await?;
    Ok(())
}
async fn canonical_import(state: &App, token: &str, body: &mut Value) -> Result<()> {
    let favorites = body.get("favorites").cloned().unwrap_or(json!([]));
    body["favorites"] = canonical_tracks(state, token, &favorites).await?;
    if let Some(playlists) = body.get_mut("playlists") {
        for p in playlists
            .as_array_mut()
            .ok_or_else(|| ApiError::invalid("playlists must be an array."))?
        {
            if !p.is_object() {
                return Err(ApiError::invalid("Expected a JSON object."));
            }
            canonical_playlist(state, token, p).await?;
        }
    }
    Ok(())
}
async fn admin(state: Arc<App>, user: User, request: Request) -> Result<Response> {
    if user.role != "admin" {
        return Err(ApiError::new(403, "ADMIN_REQUIRED"));
    }
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    if path == "/api/v1/admin/users" {
        if method == Method::GET {
            return Ok(response(state.store.call(|c|Ok(json!({"items":rows(c,"SELECT u.id,u.username,u.role,(SELECT count(*) FROM sessions s WHERE s.user_id=u.id) AS sessions,(SELECT count(*) FROM favorites f WHERE f.user_id=u.id) AS favorites,(SELECT count(*) FROM playlists p WHERE p.user_id=u.id) AS playlists FROM users u ORDER BY u.username COLLATE NOCASE",[])?}))).await?));
        }
        methods(&method, &["POST"])?;
        let b = body(request, 4096).await?;
        let username = b["username"].as_str().unwrap_or("").to_string();
        let role = match b.get("role") {
            None | Some(Value::Null) => "user",
            Some(Value::String(role)) => role.as_str(),
            _ => return Err(ApiError::invalid("Invalid username or role.")),
        }
        .to_string();
        if !auth::valid_username(&username, 4) || !["admin", "user"].contains(&role.as_str()) {
            return Err(ApiError::invalid("Invalid username or role."));
        }
        let hash = state
            .auth
            .make_hash(
                b["password"]
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("Invalid password."))?
                    .into(),
            )
            .await?;
        let result = state
            .store
            .call(move |c| {
                transaction(c, |c| {
                    if one(c, "SELECT 1 FROM users WHERE username=?", [&username])?.is_some() {
                        return Err(ApiError::new(409, "USERNAME_TAKEN"));
                    }
                    let id = uuid::Uuid::new_v4().to_string();
                    c.execute(
                        "INSERT INTO users (id,username,hash,role) VALUES (?,?,?,?)",
                        rusqlite::params![id, username, hash, role],
                    )?;
                    Ok(json!({"user":{"id":id,"username":username,"role":role}}))
                })
            })
            .await?;
        let mut res = response(result);
        *res.status_mut() = StatusCode::CREATED;
        return Ok(res);
    }
    let parts: Vec<_> = path
        .strip_prefix("/api/v1/admin/users/")
        .unwrap()
        .split('/')
        .collect();
    if parts.len() > 2 || parts[0].is_empty() {
        return Err(ApiError::missing());
    }
    let username = decode(parts[0])?;
    let action = parts.get(1).copied().unwrap_or("");
    let target = state
        .store
        .call({
            let username = username.clone();
            move |c| {
                one(
                    c,
                    "SELECT id,username,role FROM users WHERE username=?",
                    [username],
                )?
                .ok_or_else(ApiError::missing)
            }
        })
        .await?["id"]
        .as_str()
        .unwrap()
        .to_string();
    match action {
        "password" => {
            methods(&method, &["POST"])?;
            let b = body(request, 4096).await?;
            let hash = state
                .auth
                .make_hash(
                    b["password"]
                        .as_str()
                        .ok_or_else(|| ApiError::invalid("Invalid password."))?
                        .into(),
                )
                .await?;
            Ok(response(
                state
                    .store
                    .call(move |c| {
                        transaction(c, |c| {
                            let n = c.execute("DELETE FROM sessions WHERE user_id=?", [&target])?;
                            c.execute(
                                "UPDATE users SET hash=? WHERE id=?",
                                rusqlite::params![hash, target],
                            )?;
                            Ok(json!({"ok":true,"sessionsRevoked":n}))
                        })
                    })
                    .await?,
            ))
        }
        "revoke" => {
            methods(&method, &["POST"])?;
            Ok(response(
                state
                    .store
                    .call(move |c| {
                        let n = c.execute("DELETE FROM sessions WHERE user_id=?", [target])?;
                        Ok(json!({"ok":true,"sessionsRevoked":n}))
                    })
                    .await?,
            ))
        }
        "" => {
            methods(&method, &["DELETE"])?;
            let b = body(request, 1024).await?;
            if b["confirm"] != username {
                return Err(ApiError::new(400, "CONFIRM_REQUIRED"));
            }
            if target == user.id {
                return Err(ApiError::invalid(
                    "Administrators cannot delete their own accounts through the API.",
                ));
            }
            Ok(response(
                state
                    .store
                    .call(move |c| {
                        if c.execute("DELETE FROM users WHERE id=?", [target])? == 0 {
                            return Err(ApiError::missing());
                        }
                        Ok(json!({"ok":true,"deleted":username}))
                    })
                    .await?,
            ))
        }
        _ => Err(ApiError::missing()),
    }
}
