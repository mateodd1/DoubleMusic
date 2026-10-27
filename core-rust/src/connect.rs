//! Ephemeral, account-scoped Connect v1 coordinator. No media URLs or users DB.
use crate::{
    auth::{self, Auth, User},
    db::{self, Store},
    error::{ApiError, Result},
};
use axum::{
    extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use rusqlite::params_from_iter;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, watch};

const MAX_MESSAGE: usize = 2 * 1024 * 1024;
const STALE_MS: i64 = 20000;
const COMMAND_MS: i64 = 5000;
#[derive(Clone)]
struct Options {
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    interval: Duration,
    public_url: String,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            now: Arc::new(db::now),
            interval: Duration::from_secs(5),
            public_url: String::new(),
        }
    }
}
#[derive(Clone)]
pub struct Connect {
    inner: Arc<Mutex<Hub>>,
    store: Store,
    origins: Arc<Vec<String>>,
    options: Options,
}
#[derive(Clone, Debug)]
enum Closing {
    Terminate,
    Close(u16, &'static str),
}
struct Queued {
    message: Message,
    _permit: OwnedSemaphorePermit,
}
#[derive(Clone)]
struct Outbox {
    tx: mpsc::Sender<Queued>,
    close: watch::Sender<Option<Closing>>,
    budget: Arc<Semaphore>,
}
impl Outbox {
    fn send(&self, message: Message) {
        if self.close.borrow().is_some() {
            return;
        }
        let size = match &message {
            Message::Text(v) => v.len(),
            Message::Binary(v) => v.len(),
            _ => 1,
        };
        let permit = self.budget.clone().try_acquire_many_owned(size as u32);
        if let Ok(permit) = permit
            && self
                .tx
                .try_send(Queued {
                    message,
                    _permit: permit,
                })
                .is_ok()
        {
            return;
        }
        self.stop(Closing::Terminate);
    }
    fn json(&self, value: Value) {
        self.send(Message::Text(value.to_string().into()));
    }
    fn stop(&self, reason: Closing) {
        if self.close.borrow().is_none() {
            self.close.send_replace(Some(reason));
        }
    }
    fn open(&self) -> bool {
        self.close.borrow().is_none()
    }
}
struct Peer {
    id: String,
    user: String,
    digest: String,
    out: Outbox,
    opened_at: i64,
    pong_at: i64,
    rate_at: i64,
    count: u32,
    role: Option<String>,
    device_key: String,
    instance_id: String,
    platform: String,
    name: String,
    capabilities: Vec<&'static str>,
    state: Option<Value>,
    updated_at: i64,
    sequence: u64,
    visible: bool,
    seen: VecDeque<String>,
}
impl Peer {
    fn live(&self, now: i64) -> bool {
        self.role.as_deref() == Some("player")
            && self.state.is_some()
            && now - self.updated_at < STALE_MS
            && self.out.open()
    }
    fn device(&self) -> Value {
        json!({"id":self.id,"instanceId":self.instance_id,"name":self.name,"platform":self.platform,"capabilities":self.capabilities,"state":self.state})
    }
}
#[derive(Clone)]
struct Pending {
    controller: String,
    client_id: String,
    target: String,
    action: String,
    track_id: String,
    expires_at: i64,
}
struct Hub {
    peers: HashMap<String, Peer>,
    order: Vec<String>,
    pending: HashMap<String, Pending>,
    closed: bool,
    public_url: String,
}
struct Registration {
    id: String,
    rx: mpsc::Receiver<Queued>,
    close: watch::Receiver<Option<Closing>>,
}
impl Connect {
    pub fn new(auth: &Auth, origins: Vec<String>, public_url: String) -> Self {
        Self::with_options(
            auth.store.clone(),
            origins,
            Options {
                public_url,
                ..Options::default()
            },
        )
    }
    fn with_options(store: Store, origins: Vec<String>, options: Options) -> Self {
        let inner = Arc::new(Mutex::new(Hub {
            peers: HashMap::new(),
            order: vec![],
            pending: HashMap::new(),
            closed: false,
            public_url: options.public_url.clone(),
        }));
        let connect = Self {
            inner,
            store,
            origins: Arc::new(origins),
            options,
        };
        let weak: Weak<Mutex<Hub>> = Arc::downgrade(&connect.inner);
        let store = connect.store.clone();
        let options = connect.options.clone();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(options.interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            timer.tick().await;
            loop {
                timer.tick().await;
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let mut hub = inner.lock().await;
                if hub.closed {
                    break;
                }
                hub.refresh(&store, None, (options.now)()).await;
                hub.sweep((options.now)());
            }
        });
        connect
    }
    pub async fn upgrade(
        &self,
        auth: &Auth,
        headers: HeaderMap,
        upgrade: WebSocketUpgrade,
    ) -> Result<Response> {
        let allowed = match headers.get("origin") {
            Some(origin) => origin
                .to_str()
                .is_ok_and(|origin| self.origins.iter().any(|s| s == origin)),
            None => headers.contains_key("authorization"),
        };
        if !allowed {
            return Err(ApiError::new(403, "CONNECT_ORIGIN_FORBIDDEN"));
        }
        // The regular SQLite authority is used, never playbackAccess or another DB.
        let user = auth.authenticate(&headers).await?;
        let registration = self
            .register(user, auth::digest(&auth::token(&headers)))
            .await?;
        let failed = self.clone();
        let failed_id = registration.id.clone();
        let running = self.clone();
        Ok(upgrade
            .max_message_size(MAX_MESSAGE)
            .max_frame_size(MAX_MESSAGE)
            .max_write_buffer_size(MAX_MESSAGE)
            .on_failed_upgrade(move |_| {
                tokio::spawn(async move {
                    failed.disconnect(&failed_id).await;
                });
            })
            .on_upgrade(move |socket| running.serve(socket, registration)))
    }
    async fn register(&self, user: User, digest: String) -> Result<Registration> {
        let mut hub = self.inner.lock().await;
        if hub.closed {
            return Err(ApiError::new(503, "CONNECT_UNAVAILABLE"));
        }
        if hub.peers.len() >= 512 || hub.peers.values().filter(|p| p.user == user.id).count() >= 16
        {
            return Err(ApiError::new(429, "CONNECT_LIMIT_REACHED"));
        }
        let (tx, rx) = mpsc::channel(32);
        let (close, close_rx) = watch::channel(None);
        let id = uuid::Uuid::new_v4().to_string();
        let now = (self.options.now)();
        hub.order.push(id.clone());
        hub.peers.insert(
            id.clone(),
            Peer {
                id: id.clone(),
                user: user.id,
                digest,
                out: Outbox {
                    tx,
                    close,
                    budget: Arc::new(Semaphore::new(MAX_MESSAGE)),
                },
                opened_at: now,
                pong_at: now,
                rate_at: now,
                count: 0,
                role: None,
                device_key: String::new(),
                instance_id: String::new(),
                platform: String::new(),
                name: String::new(),
                capabilities: vec![],
                state: None,
                updated_at: 0,
                sequence: 0,
                visible: false,
                seen: VecDeque::new(),
            },
        );
        Ok(Registration {
            id,
            rx,
            close: close_rx,
        })
    }
    async fn serve(self, socket: WebSocket, mut registration: Registration) {
        let (mut sink, mut stream) = socket.split();
        let id = &registration.id;
        let reason = {
            let read = async {
                while let Some(Ok(message)) = stream.next().await {
                    match message {
                        Message::Text(raw) => self.message(id, raw.as_str()).await,
                        Message::Binary(_) => {
                            self.inner
                                .lock()
                                .await
                                .stop(id, Closing::Close(1008, "Rate or format"));
                            break;
                        }
                        Message::Pong(_) => {
                            if let Some(p) = self.inner.lock().await.peers.get_mut(id) {
                                p.pong_at = (self.options.now)();
                            }
                        }
                        Message::Ping(data) => {
                            if let Some(p) = self.inner.lock().await.peers.get(id) {
                                p.out.send(Message::Pong(data));
                            }
                        }
                        Message::Close(_) => break,
                    }
                }
            };
            let write = async {
                while let Some(queued) = registration.rx.recv().await {
                    let sent =
                        tokio::time::timeout(Duration::from_secs(5), sink.send(queued.message))
                            .await;
                    if !matches!(sent, Ok(Ok(()))) {
                        break;
                    }
                }
            };
            tokio::select! {biased; _=registration.close.changed()=>registration.close.borrow().clone(),_=read=>None,_=write=>None}
        };
        let reason = reason.or_else(|| registration.close.borrow().clone());
        if let Some(Closing::Close(code, reason)) = reason {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                sink.send(Message::Close(Some(CloseFrame {
                    code,
                    reason: reason.into(),
                }))),
            )
            .await;
        }
        self.disconnect(id).await;
    }
    async fn message(&self, id: &str, raw: &str) {
        let mut hub = self.inner.lock().await;
        let Some(user) = hub.peers.get(id).map(|p| p.user.clone()) else {
            return;
        };
        hub.refresh(&self.store, Some(&user), (self.options.now)())
            .await;
        let now = (self.options.now)();
        let Some(peer) = hub.peers.get_mut(id) else {
            return;
        };
        if now - peer.rate_at > 1000 {
            peer.rate_at = now;
            peer.count = 0;
        }
        peer.count += 1;
        if peer.count > 40 {
            hub.stop(id, Closing::Close(1008, "Rate or format"));
            return;
        }
        let message = serde_json::from_str::<Value>(raw)
            .ok()
            .filter(Value::is_object);
        if message.is_none()
            || hub
                .message(id, &message.unwrap_or(Value::Null), raw.len(), now)
                .is_err()
        {
            hub.stop(id, Closing::Close(1008, "Invalid connect message"));
        }
    }
    async fn disconnect(&self, id: &str) {
        let mut hub = self.inner.lock().await;
        if let Some(user) = hub.peers.get(id).map(|p| p.user.clone()) {
            hub.refresh(&self.store, Some(&user), (self.options.now)())
                .await;
        }
        hub.remove(id, (self.options.now)());
    }
    pub async fn drain(&self) {
        self.inner.lock().await.drain();
    }
    pub async fn close(&self) {
        let mut hub = self.inner.lock().await;
        hub.closed = true;
        hub.drain();
    }
}

impl Hub {
    fn drain(&mut self) {
        for p in self.peers.values() {
            p.out.stop(Closing::Close(1012, "Service restart"));
        }
        self.pending.clear();
        self.peers.clear();
        self.order.clear();
    }
    async fn refresh(&mut self, store: &Store, user: Option<&str>, now: i64) {
        let selected: Vec<(String, String)> = self
            .peers
            .values()
            .filter(|p| user.is_none_or(|u| p.user == u))
            .map(|p| (p.id.clone(), p.digest.clone()))
            .collect();
        if selected.is_empty() {
            return;
        }
        let digests: Vec<String> = selected.iter().map(|(_, d)| d.clone()).collect();
        let valid = store
            .call(move |c| {
                let placeholders = vec!["?"; digests.len()].join(",");
                let sql = format!(
                    "SELECT digest FROM sessions WHERE expires_at>? AND digest IN ({placeholders})"
                );
                let mut stmt = c.prepare_cached(&sql)?;
                let params = std::iter::once(rusqlite::types::Value::Integer(now))
                    .chain(digests.into_iter().map(rusqlite::types::Value::Text));
                Ok(stmt
                    .query_map(params_from_iter(params), |r| r.get::<_, String>(0))?
                    .collect::<std::result::Result<HashSet<_>, _>>()?)
            })
            .await;
        for (id, digest) in selected {
            match &valid {
                Ok(valid) if !valid.contains(&digest) => {
                    self.stop(&id, Closing::Close(4001, "Session expired"))
                }
                Err(_) => self.stop(&id, Closing::Close(1011, "Authorization unavailable")),
                _ => {}
            }
        }
        // Remove revoked peers before any broadcast or command can target them.
        let closed: Vec<_> = self
            .peers
            .values()
            .filter(|p| !p.out.open() && user.is_none_or(|u| p.user == u))
            .map(|p| p.id.clone())
            .collect();
        for id in closed {
            self.remove(&id, now);
        }
    }
    fn stop(&self, id: &str, reason: Closing) {
        if let Some(p) = self.peers.get(id) {
            p.out.stop(reason);
        }
    }
    fn devices(&self, user: &str, now: i64) -> Vec<Value> {
        self.order
            .iter()
            .filter_map(|id| self.peers.get(id))
            .filter(|p| p.user == user && p.live(now))
            .map(Peer::device)
            .collect()
    }
    fn broadcast(&self, user: &str, now: i64) {
        let message: Utf8Bytes =
            json!({"type":"devices","items":self.devices(user,now),"serverTime":now})
                .to_string()
                .into();
        for p in self
            .peers
            .values()
            .filter(|p| p.user == user && p.role.as_deref() == Some("controller"))
        {
            p.out.send(Message::Text(message.clone()));
        }
    }
    fn finish(&mut self, id: &str, result: Value) {
        let Some(item) = self.pending.remove(id) else {
            return;
        };
        if let Some(controller) = self.peers.get(&item.controller) {
            let mut value = json!({"type":"result","id":item.client_id});
            value
                .as_object_mut()
                .unwrap()
                .extend(result.as_object().unwrap().clone());
            controller.out.json(value);
        }
    }
    fn remove(&mut self, id: &str, now: i64) {
        let Some(peer) = self.peers.remove(id) else {
            return;
        };
        self.order.retain(|i| i != id);
        let pending: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.target == id || p.controller == id)
            .map(|(id, p)| (id.clone(), p.target == peer.id))
            .collect();
        for (id, target) in pending {
            if target {
                self.finish(&id, json!({"ok":false,"error":"DEVICE_OFFLINE"}));
            } else {
                self.pending.remove(&id);
            }
        }
        self.broadcast(&peer.user, now);
    }
    fn sweep(&mut self, now: i64) {
        let mut changed = HashSet::new();
        let mut remove = vec![];
        for p in self.peers.values_mut() {
            if !p.out.open()
                || now - p.pong_at >= STALE_MS
                || (p.role.is_none() && now - p.opened_at >= 5000)
            {
                p.out.stop(Closing::Terminate);
                remove.push(p.id.clone());
                continue;
            }
            let visible = p.live(now);
            if visible != p.visible {
                p.visible = visible;
                changed.insert(p.user.clone());
            }
            if p.role.as_deref() == Some("controller") {
                p.out.json(json!({"type":"heartbeat"}));
            }
            p.out.send(Message::Ping(Vec::new().into()));
        }
        for id in remove {
            self.remove(&id, now);
        }
        let expired: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.expires_at <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.finish(&id, json!({"ok":false,"error":"DEVICE_TIMEOUT"}));
        }
        for user in changed {
            self.broadcast(&user, now);
        }
    }
    fn message(
        &mut self,
        id: &str,
        m: &Value,
        size: usize,
        now: i64,
    ) -> std::result::Result<(), ()> {
        let peer = self.peers.get(id).ok_or(())?;
        let role = peer.role.as_deref();
        match (m["type"].as_str(), role) {
            (_, None) => self.hello(id, m, now),
            (Some("state"), Some("player")) => self.state(id, m, size, now),
            (Some("command"), Some("controller")) => self.command(id, m, size, now),
            (Some("ack"), Some("player")) => self.ack(id, m, now),
            _ => Err(()),
        }
    }
    fn hello(&mut self, id: &str, m: &Value, now: i64) -> std::result::Result<(), ()> {
        let role = m["role"].as_str().ok_or(())?;
        if m["type"] != "hello" || m["version"] != 1 || !["player", "controller"].contains(&role) {
            return Err(());
        }
        if role == "player" {
            let platform = m["platform"]
                .as_str()
                .filter(|p| ["ios", "android"].contains(p))
                .ok_or(())?;
            let key = m["deviceKey"]
                .as_str()
                .filter(|s| identifier(s, 8, 128))
                .ok_or(())?;
            let capabilities = if let Some(c) = m.get("capabilities") {
                let c = c.as_array().filter(|c| c.len() <= 16).ok_or(())?;
                if c.iter()
                    .any(|v| v.as_str().is_none_or(|s| s.encode_utf16().count() > 64))
                {
                    return Err(());
                }
                if c.iter().any(|v| v == "playQueue") {
                    vec!["playQueue"]
                } else {
                    vec![]
                }
            } else {
                vec![]
            };
            let user = self.peers[id].user.clone();
            let old: Vec<_> = self
                .peers
                .values()
                .filter(|p| p.id != id && p.user == user && p.device_key == key)
                .map(|p| p.id.clone())
                .collect();
            for old in old {
                self.stop(&old, Closing::Close(4000, "Replaced"));
                self.remove(&old, now);
            }
            let peer = self.peers.get_mut(id).ok_or(())?;
            peer.device_key = key.into();
            peer.platform = platform.into();
            peer.capabilities = capabilities;
            peer.name = text(&m["name"], 64).trim().into();
            if peer.name.is_empty() {
                peer.name = if platform == "ios" {
                    "iPhone / iPad"
                } else {
                    "Android"
                }
                .into();
            }
            peer.instance_id = auth::digest(&json!([user, key]).to_string());
        }
        let peer = self.peers.get_mut(id).ok_or(())?;
        peer.role = Some(role.into());
        peer.out
            .json(json!({"type":"ready","version":1,"deviceId":id,"serverTime":now}));
        if role == "controller" {
            let user = peer.user.clone();
            let out = peer.out.clone();
            out.json(json!({"type":"devices","items":self.devices(&user,now),"serverTime":now}));
        }
        Ok(())
    }
    fn state(&mut self, id: &str, m: &Value, size: usize, now: i64) -> std::result::Result<(), ()> {
        if size > 16384 {
            return Err(());
        }
        let s = m.get("state").ok_or(())?;
        let state = if s.is_null() {
            None
        } else {
            let position = seconds(&s["position"]).ok_or(())?;
            let duration = seconds(&s["duration"]).ok_or(())?;
            let playing = s["playing"].as_bool().ok_or(())?;
            let track = track(&s["track"], &self.public_url)?;
            let p = self.peers.get_mut(id).ok_or(())?;
            p.sequence += 1;
            Some(
                json!({"track":track,"position":if duration==0.0{position}else{position.min(duration)},"duration":duration,"playing":playing,"buffering":s["buffering"]==true,"canNext":s["canNext"]==true,"updatedAt":now,"sequence":p.sequence}),
            )
        };
        let p = self.peers.get_mut(id).ok_or(())?;
        p.visible = state.is_some();
        if state.is_some() {
            p.updated_at = now;
        }
        p.state = state;
        let user = p.user.clone();
        self.broadcast(&user, now);
        Ok(())
    }
    fn command(
        &mut self,
        id: &str,
        m: &Value,
        size: usize,
        now: i64,
    ) -> std::result::Result<(), ()> {
        let client_id = m["id"]
            .as_str()
            .filter(|s| identifier(s, 1, 64))
            .ok_or(())?;
        let action = m["action"]
            .as_str()
            .filter(|s| {
                [
                    "play",
                    "pause",
                    "next",
                    "previous",
                    "seek",
                    "transfer",
                    "playQueue",
                ]
                .contains(s)
            })
            .ok_or(())?;
        if action != "playQueue" && size > 2048 {
            return Err(());
        }
        let p = self.peers.get_mut(id).ok_or(())?;
        let fail = |code: &str| {
            p.out
                .json(json!({"type":"result","id":client_id,"ok":false,"error":code}))
        };
        if p.seen.iter().any(|s| s == client_id) {
            fail("DUPLICATE_COMMAND");
            return Ok(());
        }
        p.seen.push_back(client_id.into());
        if p.seen.len() > 128 {
            p.seen.pop_front();
        }
        let p = &self.peers[id];
        let fail = |code: &str| {
            p.out
                .json(json!({"type":"result","id":client_id,"ok":false,"error":code}))
        };
        if self.pending.values().filter(|v| v.controller == id).count() >= 8 {
            fail("TOO_MANY_COMMANDS");
            return Ok(());
        }
        let target = m["deviceId"]
            .as_str()
            .and_then(|id| self.peers.get(id))
            .filter(|t| t.user == p.user && t.live(now));
        let Some(target) = target else {
            fail("DEVICE_OFFLINE");
            return Ok(());
        };
        let target_state = target.state.as_ref().unwrap();
        if action != "playQueue" && m["trackId"] != target_state["track"]["id"] {
            fail("TRACK_CHANGED");
            return Ok(());
        }
        let queue = if action == "playQueue" {
            if !target.capabilities.contains(&"playQueue") {
                fail("UNSUPPORTED_COMMAND");
                return Ok(());
            }
            if size > MAX_MESSAGE - 1024 {
                fail("INVALID_QUEUE");
                return Ok(());
            }
            let parsed = queue(m, &self.public_url).and_then(|mut q| {
                q["shuffle"] = json!(m["shuffle"].as_bool().ok_or(())?);
                Ok(q)
            });
            let Ok(queue) = parsed else {
                fail("INVALID_QUEUE");
                return Ok(());
            };
            Some(queue)
        } else {
            None
        };
        if action == "seek"
            && seconds(&m["position"])
                .is_none_or(|v| v > target_state["duration"].as_f64().unwrap())
        {
            fail("INVALID_POSITION");
            return Ok(());
        }
        if self
            .pending
            .values()
            .any(|p| p.target == target.id && (p.action == "transfer" || action == "transfer"))
        {
            fail("DEVICE_BUSY");
            return Ok(());
        }
        let command_id = uuid::Uuid::new_v4().to_string();
        let expires_at = now + COMMAND_MS;
        let track_id = if let Some(q) = &queue {
            q["queue"][q["index"].as_u64().unwrap() as usize]["id"]
                .as_str()
                .unwrap()
        } else {
            m["trackId"].as_str().unwrap()
        }
        .to_string();
        let mut command =
            json!({"type":"command","id":command_id,"action":action,"expiresAt":expires_at});
        if let Some(q) = queue {
            command
                .as_object_mut()
                .unwrap()
                .extend(q.as_object().unwrap().clone());
        } else {
            command["trackId"] = m["trackId"].clone();
        }
        if action == "seek" {
            command["position"] = m["position"].clone();
        }
        self.pending.insert(
            command_id,
            Pending {
                controller: id.into(),
                client_id: client_id.into(),
                target: target.id.clone(),
                action: action.into(),
                track_id,
                expires_at,
            },
        );
        target.out.json(command);
        Ok(())
    }
    fn ack(&mut self, id: &str, m: &Value, now: i64) -> std::result::Result<(), ()> {
        let Some(command_id) = m["id"].as_str() else {
            return Ok(());
        };
        let Some(item) = self
            .pending
            .get(command_id)
            .filter(|p| p.target == id)
            .cloned()
        else {
            return Ok(());
        };
        if now >= item.expires_at {
            self.finish(command_id, json!({"ok":false,"error":"DEVICE_TIMEOUT"}));
            return Ok(());
        }
        if m["ok"] != true {
            self.finish(command_id, json!({"ok":false,"error":"COMMAND_FAILED"}));
            return Ok(());
        }
        let p = self.peers.get(id).ok_or(())?;
        if item.action == "playQueue"
            && p.state.as_ref().map(|s| s["track"]["id"].as_str().unwrap())
                != Some(item.track_id.as_str())
        {
            self.finish(command_id, json!({"ok":false,"error":"COMMAND_FAILED"}));
            return Ok(());
        }
        let mut result = json!({"ok":true});
        if item.action == "transfer" {
            let s = &m["snapshot"];
            let position = seconds(&s["position"]).ok_or(())?;
            let repeat = s["repeat"]
                .as_str()
                .filter(|s| ["off", "all", "one"].contains(s))
                .ok_or(())?;
            let mut snapshot = queue(s, &self.public_url)?;
            snapshot["position"] = json!(position);
            snapshot["repeat"] = json!(repeat);
            if snapshot["queue"][snapshot["index"].as_u64().unwrap() as usize]["id"]
                != item.track_id
            {
                return Err(());
            }
            if p.state
                .as_ref()
                .is_none_or(|s| s["playing"] != false || s["track"]["id"] != item.track_id)
            {
                return Err(());
            }
            result["snapshot"] = snapshot;
        }
        if item.action == "seek" {
            if p.live(now) {
                result["device"] = p.device();
            }
            result["serverTime"] = json!(now);
        }
        self.finish(command_id, result);
        Ok(())
    }
}
fn identifier(s: &str, min: usize, max: usize) -> bool {
    s.len() >= min
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn seconds(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 86400.0)
}
fn text(value: &Value, max: usize) -> String {
    value.as_str().unwrap_or("").chars().take(max).collect()
}
fn track(t: &Value, public_url: &str) -> std::result::Result<Value, ()> {
    let id = t["id"].as_str().ok_or(())?;
    crate::library::reference(id).map_err(|_| ())?;
    let raw = t["coverUrl"].as_str().unwrap_or("");
    let image = if !public_url.is_empty() {
        raw.strip_prefix(public_url).unwrap_or(raw)
    } else {
        raw
    };
    let cover = if crate::library::local_image(image) {
        format!("{public_url}{image}")
    } else {
        String::new()
    };
    Ok(
        json!({"id":id,"title":text(&t["title"],256),"artist":text(&t["artist"],256),"album":text(&t["album"],256),"artistId":text(&t["artistId"],160),"albumId":text(&t["albumId"],160),"coverUrl":cover,"duration":seconds(&t["duration"]).unwrap_or(0.0)}),
    )
}
fn queue(m: &Value, public_url: &str) -> std::result::Result<Value, ()> {
    let q = m["queue"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 1000)
        .ok_or(())?;
    let index = m["index"]
        .as_f64()
        .filter(|v| v.fract() == 0.0 && *v >= 0.0 && *v < (q.len() as f64))
        .ok_or(())? as usize;
    let tracks = q
        .iter()
        .map(|t| track(t, public_url))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(json!({"queue":tracks,"index":index}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    struct Fixture {
        connect: Connect,
        clock: Arc<AtomicI64>,
    }
    impl Fixture {
        async fn new() -> Self {
            let store = Store::open(":memory:").unwrap();
            let now = db::now();
            store
                .call(move |c| {
                    for name in ["alice", "bobby"] {
                        c.execute(
                            "INSERT INTO users VALUES (?,?,?,'user',0)",
                            rusqlite::params![name, name, "not-used"],
                        )?;
                        c.execute(
                            "INSERT INTO sessions VALUES (?,?,?,?)",
                            rusqlite::params![name, name, now + auth::TTL, now],
                        )?;
                    }
                    Ok(())
                })
                .await
                .unwrap();
            let clock = Arc::new(AtomicI64::new(now));
            let clock_fn = clock.clone();
            let connect = Connect::with_options(
                store,
                vec![],
                Options {
                    now: Arc::new(move || clock_fn.load(Ordering::SeqCst)),
                    interval: Duration::from_secs(3600),
                    public_url: String::new(),
                },
            );
            Self { connect, clock }
        }
        fn now(&self) -> i64 {
            self.clock.load(Ordering::SeqCst)
        }
        fn advance(&self, ms: i64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }
        async fn peer(&self, user: &str, role: &str) -> Registration {
            let r = self
                .connect
                .register(
                    User {
                        id: user.into(),
                        username: user.into(),
                        role: "user".into(),
                        expires_at: self.now() + auth::TTL,
                    },
                    user.into(),
                )
                .await
                .unwrap();
            self.send(&r,json!({"type":"hello","version":1,"role":role,"platform":"android","deviceKey":format!("installation_{}",r.id),"capabilities":["playQueue"]})).await;
            r
        }
        async fn send(&self, r: &Registration, value: Value) {
            self.connect.message(&r.id, &value.to_string()).await;
        }
        async fn publish(&self, p: &Registration, playing: bool) {
            self.send(p,json!({"type":"state","state":{"track":song(),"position":42,"duration":180,"playing":playing}})).await;
        }
        async fn sweep(&self) {
            let mut h = self.connect.inner.lock().await;
            h.refresh(&self.connect.store, None, self.now()).await;
            h.sweep(self.now());
        }
    }
    fn song() -> Value {
        json!({"id":"local:t_song","title":"Test","artist":"Artist","duration":180})
    }
    fn take(r: &mut Registration, kind: &str) -> Value {
        while let Ok(q) = r.rx.try_recv() {
            if let Message::Text(s) = q.message {
                let m: Value = serde_json::from_str(&s).unwrap();
                if m["type"] == kind {
                    return m;
                }
            }
        }
        panic!("Missing {kind}");
    }
    fn drain(r: &mut Registration) {
        while r.rx.try_recv().is_ok() {}
    }

    #[tokio::test]
    async fn command_deadline_and_stale_presence_are_independent_of_pongs() {
        let f = Fixture::new().await;
        let mut p = f.peer("alice", "player").await;
        let mut c = f.peer("alice", "controller").await;
        drain(&mut p);
        drain(&mut c);
        f.publish(&p, true).await;
        drain(&mut c);
        f.send(&c,json!({"type":"command","id":"timeout","deviceId":p.id,"trackId":"local:t_song","action":"pause"})).await;
        let cmd = take(&mut p, "command");
        f.advance(5000);
        f.send(&p, json!({"type":"ack","id":cmd["id"],"ok":true}))
            .await;
        assert_eq!(take(&mut c, "result")["error"], "DEVICE_TIMEOUT");
        f.advance(15000);
        // A healthy transport does not make an obsolete playback sample live.
        for peer in f.connect.inner.lock().await.peers.values_mut() {
            peer.pong_at = f.now();
        }
        f.sweep().await;
        assert!(
            f.connect
                .inner
                .lock()
                .await
                .devices("alice", f.now())
                .is_empty()
        );
        f.publish(&p, false).await;
        assert_eq!(
            f.connect.inner.lock().await.devices("alice", f.now()).len(),
            1
        );
    }
    #[tokio::test]
    async fn pending_commands_expire_on_sweep_and_failed_ack_is_explicit() {
        let f = Fixture::new().await;
        let mut p = f.peer("alice", "player").await;
        let mut c = f.peer("alice", "controller").await;
        drain(&mut p);
        drain(&mut c);
        f.publish(&p, true).await;
        drain(&mut c);
        f.send(&c,json!({"type":"command","id":"no_ack","deviceId":p.id,"trackId":"local:t_song","action":"pause"})).await;
        take(&mut p, "command");
        f.advance(5000);
        f.sweep().await;
        assert_eq!(take(&mut c, "result")["error"], "DEVICE_TIMEOUT");
        f.send(&c,json!({"type":"command","id":"failed","deviceId":p.id,"trackId":"local:t_song","action":"play"})).await;
        let cmd = take(&mut p, "command");
        f.send(&p, json!({"type":"ack","id":cmd["id"],"ok":false}))
            .await;
        assert_eq!(take(&mut c, "result")["error"], "COMMAND_FAILED");
    }
    #[tokio::test]
    async fn revocation_is_checked_on_messages_and_sweeps() {
        let f = Fixture::new().await;
        let mut p = f.peer("alice", "player").await;
        let c = f.peer("alice", "controller").await;
        let mut other = f.peer("bobby", "controller").await;
        drain(&mut p);
        f.publish(&p, true).await;
        f.connect
            .store
            .call(|c| {
                c.execute("DELETE FROM sessions WHERE digest='alice'", [])?;
                Ok(())
            })
            .await
            .unwrap();
        f.send(&p, json!({"type":"state","state":null})).await;
        assert!(matches!(*p.close.borrow(), Some(Closing::Close(4001, _))));
        assert!(matches!(*c.close.borrow(), Some(Closing::Close(4001, _))));
        assert!(other.close.borrow().is_none());
        f.connect
            .store
            .call(|c| {
                c.execute("DELETE FROM users WHERE id='bobby'", [])?;
                Ok(())
            })
            .await
            .unwrap();
        f.sweep().await;
        assert!(matches!(
            *other.close.borrow(),
            Some(Closing::Close(4001, _))
        ));
        drain(&mut other);
    }
    #[tokio::test]
    async fn silent_socket_and_missing_hello_are_removed() {
        let f = Fixture::new().await;
        let r = f
            .connect
            .register(
                User {
                    id: "alice".into(),
                    username: "alice".into(),
                    role: "user".into(),
                    expires_at: f.now() + 100000,
                },
                "alice".into(),
            )
            .await
            .unwrap();
        f.advance(5000);
        f.sweep().await;
        assert!(matches!(*r.close.borrow(), Some(Closing::Terminate)));
        let p = f.peer("alice", "player").await;
        f.publish(&p, true).await;
        f.advance(STALE_MS);
        f.sweep().await;
        assert!(matches!(*p.close.borrow(), Some(Closing::Terminate)));
        assert!(f.connect.inner.lock().await.peers.is_empty());
    }
    #[tokio::test]
    async fn drain_reconnects_clients_without_closing_the_coordinator() {
        let f = Fixture::new().await;
        let p = f.peer("alice", "player").await;
        f.publish(&p, true).await;
        f.connect.drain().await;
        assert!(matches!(*p.close.borrow(), Some(Closing::Close(1012, _))));
        assert!(
            f.connect
                .inner
                .lock()
                .await
                .devices("alice", f.now())
                .is_empty()
        );
        let new = f.peer("alice", "player").await;
        f.publish(&new, true).await;
        assert_eq!(
            f.connect.inner.lock().await.devices("alice", f.now()).len(),
            1
        );
    }
    #[tokio::test]
    async fn global_and_account_admission_limits_are_atomic() {
        let f = Fixture::new().await;
        let mut reservations = vec![];
        for i in 0..512 {
            let user = format!("account{}", i / 16);
            reservations.push(
                f.connect
                    .register(
                        User {
                            id: user.clone(),
                            username: user.clone(),
                            role: "user".into(),
                            expires_at: f.now() + 100000,
                        },
                        user,
                    )
                    .await
                    .unwrap(),
            );
            if i == 15 {
                let e = f
                    .connect
                    .register(
                        User {
                            id: "account0".into(),
                            username: "account0".into(),
                            role: "user".into(),
                            expires_at: f.now() + 100000,
                        },
                        "account0".into(),
                    )
                    .await
                    .err()
                    .unwrap();
                assert_eq!(e.status, 429);
            }
        }
        let e = f
            .connect
            .register(
                User {
                    id: "new_account".into(),
                    username: "new".into(),
                    role: "user".into(),
                    expires_at: f.now() + 100000,
                },
                "new".into(),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(e.status, 429);
        f.connect.close().await;
        assert!(
            reservations
                .iter()
                .all(|p| matches!(*p.close.borrow(), Some(Closing::Close(1012, _))))
        );
        let e = f
            .connect
            .register(
                User {
                    id: "alice".into(),
                    username: "alice".into(),
                    role: "user".into(),
                    expires_at: f.now() + 100000,
                },
                "alice".into(),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(e.status, 503);
    }
    #[tokio::test]
    async fn pending_and_seen_limits_reject_repeats_and_forged_ack() {
        let f = Fixture::new().await;
        let mut p = f.peer("alice", "player").await;
        let mut c = f.peer("alice", "controller").await;
        let stranger = f.peer("bobby", "player").await;
        drain(&mut p);
        drain(&mut c);
        f.publish(&p, true).await;
        drain(&mut c);
        for i in 0..8 {
            f.send(&c,json!({"type":"command","id":format!("c{i}"),"deviceId":p.id,"trackId":"local:t_song","action":"pause"})).await;
        }
        f.send(&c,json!({"type":"command","id":"overflow","deviceId":p.id,"trackId":"local:t_song","action":"pause"})).await;
        assert_eq!(take(&mut c, "result")["error"], "TOO_MANY_COMMANDS");
        let command = take(&mut p, "command");
        f.send(
            &stranger,
            json!({"type":"ack","id":command["id"],"ok":true}),
        )
        .await;
        assert_eq!(f.connect.inner.lock().await.pending.len(), 8);
        f.send(&c,json!({"type":"command","id":"c0","deviceId":p.id,"trackId":"local:t_song","action":"pause"})).await;
        assert_eq!(take(&mut c, "result")["error"], "DUPLICATE_COMMAND");
        f.connect.disconnect(&p.id).await;
        for _ in 0..8 {
            assert_eq!(take(&mut c, "result")["error"], "DEVICE_OFFLINE");
        }
        assert!(f.connect.inner.lock().await.pending.is_empty());
    }
    #[tokio::test]
    async fn transfer_locks_the_source_until_confirmation() {
        let f = Fixture::new().await;
        let mut p = f.peer("alice", "player").await;
        let mut c = f.peer("alice", "controller").await;
        drain(&mut p);
        drain(&mut c);
        f.publish(&p, true).await;
        drain(&mut c);
        f.send(&c,json!({"type":"command","id":"transfer","deviceId":p.id,"trackId":"local:t_song","action":"transfer"})).await;
        let cmd = take(&mut p, "command");
        f.send(&c,json!({"type":"command","id":"racing_seek","deviceId":p.id,"trackId":"local:t_song","action":"seek","position":100})).await;
        assert_eq!(take(&mut c, "result")["error"], "DEVICE_BUSY");
        f.publish(&p, false).await;
        f.send(&p,json!({"type":"ack","id":cmd["id"],"ok":true,"snapshot":{"queue":[song()],"index":0,"position":42.25,"repeat":"one"}})).await;
        let result = take(&mut c, "result");
        assert_eq!(result["ok"], true);
        assert_eq!(result["snapshot"]["position"], 42.25);
        assert_eq!(result["snapshot"]["repeat"], "one");
    }
    #[tokio::test]
    async fn malformed_messages_and_message_rate_are_bounded() {
        let f = Fixture::new().await;
        let p = f.peer("alice", "player").await;
        for _ in 0..40 {
            f.send(&p, json!({"type":"state","state":null})).await;
        }
        assert!(matches!(*p.close.borrow(), Some(Closing::Close(1008, _))));
        let c = f.peer("bobby", "controller").await;
        f.connect.message(&c.id, "[]").await;
        assert!(matches!(*c.close.borrow(), Some(Closing::Close(1008, _))));
    }
    #[test]
    fn outbox_limits_memory_and_slow_consumers() {
        let (tx, _rx) = mpsc::channel(32);
        let (close, rx) = watch::channel(None);
        let out = Outbox {
            tx,
            close,
            budget: Arc::new(Semaphore::new(MAX_MESSAGE)),
        };
        out.send(Message::Text("x".repeat(MAX_MESSAGE - 10).into()));
        out.send(Message::Text("y".repeat(11).into()));
        assert!(matches!(*rx.borrow(), Some(Closing::Terminate)));
        let (tx, _rx) = mpsc::channel(32);
        let (close, rx) = watch::channel(None);
        let out = Outbox {
            tx,
            close,
            budget: Arc::new(Semaphore::new(MAX_MESSAGE)),
        };
        for _ in 0..33 {
            out.send(Message::Ping(vec![].into()));
        }
        assert!(matches!(*rx.borrow(), Some(Closing::Terminate)));
    }
    #[test]
    fn track_and_queue_normalization_strip_credentials_and_validate_ids() {
        let mut t = song();
        t["token"] = json!("secret");
        t["streamUrl"] = json!("https://example.org/audio?ticket=secret");
        t["coverUrl"] = json!("https://user:password@example.org/a.jpg");
        let out = track(&t, "").unwrap();
        assert!(out.get("token").is_none());
        assert!(out.get("streamUrl").is_none());
        assert_eq!(out["coverUrl"], "");
        t["id"] = json!("https://example.org/audio");
        assert!(track(&t, "").is_err());
        assert!(queue(&json!({"queue":[song()],"index":1.0}), "").is_err());
        assert!(queue(&json!({"queue":[],"index":0}), "").is_err());
        assert!(queue(&json!({"queue":vec![song();1001],"index":0}), "").is_err());
    }
}
