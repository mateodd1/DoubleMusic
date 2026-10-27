use crate::{
    db::{self, change, one, rev, rows},
    error::{ApiError, Result},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn reference(id: &str) -> Result<&str> {
    let (provider, source) = id
        .split_once(':')
        .ok_or_else(|| ApiError::invalid("The ID must include its source."))?;
    if provider.is_empty()
        || provider.len() > 32
        || !provider.as_bytes()[0].is_ascii_lowercase()
        || !provider
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || source.is_empty()
        || source.len() > 120
        || !source
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(ApiError::invalid("Invalid catalog ID."));
    }
    Ok(provider)
}
pub fn local_image(s: &str) -> bool {
    let Some(id) = s.strip_prefix("/api/v1/catalog/artwork/") else {
        return false;
    };
    let Some((source, raw)) = id.split_once("%3A") else {
        return false;
    };
    reference(&format!("{source}:{raw}")).is_ok()
}
fn trim(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}
pub fn name(body: &Value) -> Result<String> {
    let s = body["name"].as_str().unwrap_or("").trim();
    if s.is_empty() || s.encode_utf16().count() > 100 {
        return Err(ApiError::invalid(
            "The name must contain 1 to 100 characters.",
        ));
    }
    Ok(s.into())
}
pub fn track(v: &Value) -> Result<Value> {
    let id = v["id"].as_str().unwrap_or("");
    let provider = reference(id)?;
    if v.get("provider").is_some_and(|p| p != provider)
        || v["title"].as_str().unwrap_or("").trim().is_empty()
    {
        return Err(ApiError::invalid("Invalid track."));
    }
    let duration = match v.get("duration") {
        None => 0.0,
        Some(d) => d
            .as_f64()
            .filter(|d| d.is_finite() && *d >= 0.0)
            .ok_or_else(|| ApiError::invalid("Invalid duration."))?,
    };
    let mut out = json!({"id":id,"provider":provider,"title":trim(v["title"].as_str().unwrap(),300),"duration":duration});
    for k in ["artist", "album"] {
        if let Some(s) = v[k].as_str() {
            out[k] = json!(trim(s, 300));
        }
    }
    for k in ["artistId", "albumId"] {
        if let Some(s) = v[k].as_str().filter(|s| !s.is_empty()) {
            reference(s)?;
            out[k] = json!(s);
        } else if v
            .get(k)
            .is_some_and(|v| !v.is_null() && v != false && v != "" && v != 0)
        {
            return Err(ApiError::invalid("Invalid catalog ID."));
        }
    }
    for k in ["coverUrl", "coverUrlHi"] {
        if let Some(s) = v[k].as_str().filter(|s| !s.is_empty()) {
            if !local_image(s) {
                return Err(ApiError::invalid(
                    "Artwork must belong to the DoubleMusic catalog.",
                ));
            }
            out[k] = json!(s);
        }
    }
    if let Some(artists) = v.get("artists") {
        let artists = artists
            .as_array()
            .filter(|a| a.len() <= 10)
            .ok_or_else(|| ApiError::invalid("Up to 10 artists are allowed per track."))?;
        let mut out_artists = vec![];
        for a in artists {
            if !a.is_object() {
                return Err(ApiError::invalid("Invalid artist."));
            }
            let id = a["id"].as_str().unwrap_or("");
            if !id.is_empty() {
                reference(id)?;
            }
            out_artists.push(json!({"id":id,"name":trim(a["name"].as_str().unwrap_or(""),300)}));
        }
        out["artists"] = json!(out_artists);
    }
    Ok(out)
}
pub fn tracks(v: Option<&Value>) -> Result<Vec<Value>> {
    let Some(v) = v else {
        return Ok(vec![]);
    };
    let arr = v
        .as_array()
        .ok_or_else(|| ApiError::invalid("tracks/favorites must be an array."))?;
    let mut known = HashSet::new();
    let mut out = vec![];
    for v in arr {
        let t = track(v)?;
        if known.insert(t["id"].as_str().unwrap().to_string()) {
            out.push(t);
        }
    }
    Ok(out)
}
fn saved(c: &Connection, sql: &str, id: &str) -> Result<Vec<Value>> {
    rows(c, sql, [id])?
        .into_iter()
        .map(|r| Ok(json!({"track":parse(&r["snapshot"] )?,"addedAt":r["added_at"]})))
        .collect()
}
fn parse(v: &Value) -> Result<Value> {
    serde_json::from_str(v.as_str().unwrap_or("")).map_err(|_| ApiError::new(500, "INTERNAL_ERROR"))
}
fn snapshots(c: &Connection, sql: &str, id: &str) -> Result<Vec<Value>> {
    rows(c, sql, [id])?
        .into_iter()
        .map(|r| {
            let mut v = parse(&r["snapshot"])?;
            v["addedAt"] = r["added_at"].clone();
            Ok(v)
        })
        .collect()
}
pub fn following(c: &Connection, user: &str) -> Result<Vec<Value>> {
    let mut values = rows(
        c,
        "SELECT artist_id AS id,name,image_url AS imageUrl,added_at AS addedAt FROM follows WHERE user_id=? ORDER BY added_at DESC,artist_id",
        [user],
    )?;
    for value in &mut values {
        value["provider"] = json!(reference(value["id"].as_str().unwrap())?);
    }
    Ok(values)
}
pub fn playlist_rows(c: &Connection, user: &str) -> Result<Vec<Value>> {
    rows(
        c,
        "SELECT p.id,p.name,p.created_at AS createdAt,p.updated_at AS updatedAt,(SELECT count(*) FROM playlist_tracks WHERE playlist_id=p.id) AS trackCount,COALESCE((SELECT json_extract(snapshot,'$.coverUrl') FROM playlist_tracks WHERE playlist_id=p.id ORDER BY position LIMIT 1),'') AS coverUrl FROM playlists p WHERE user_id=? ORDER BY created_at,p.id",
        [user],
    )
}
pub fn library(c: &Connection, user: &str) -> Result<Value> {
    Ok(
        json!({"rev":rev(c,user)?,"favorites":saved(c,"SELECT snapshot,added_at FROM favorites WHERE user_id=? ORDER BY position",user)?,"playlists":playlist_rows(c,user)?,"savedPlaylists":snapshots(c,"SELECT snapshot,added_at FROM saved_playlists WHERE user_id=? ORDER BY added_at DESC,playlist_id",user)?,"savedAlbums":snapshots(c,"SELECT snapshot,added_at FROM saved_albums WHERE user_id=? ORDER BY added_at DESC,album_id",user)?,"following":following(c,user)?}),
    )
}
fn owned(c: &Connection, user: &str, id: &str) -> Result<Value> {
    one(
        c,
        "SELECT * FROM playlists WHERE id=? AND user_id=?",
        params![id, user],
    )?
    .ok_or_else(ApiError::missing)
}
pub fn playlist(c: &Connection, user: &str, id: &str) -> Result<Value> {
    let p = owned(c, user, id)?;
    Ok(
        json!({"id":p["id"],"name":p["name"],"createdAt":p["created_at"],"updatedAt":p["updated_at"],"tracks":saved(c,"SELECT snapshot,added_at FROM playlist_tracks WHERE playlist_id=? ORDER BY position",id)?}),
    )
}
fn count(c: &Connection, sql: &str, user: &str) -> Result<i64> {
    Ok(c.query_row(sql, [user], |r| r.get(0))?)
}
fn bump(c: &Connection, id: &str) -> Result<()> {
    c.execute(
        "UPDATE playlists SET updated_at=max(?,updated_at+1) WHERE id=?",
        params![db::now(), id],
    )?;
    Ok(())
}
fn insert_tracks(c: &Connection, id: &str, tracks: &[Value], at: i64) -> Result<usize> {
    let existing = rows(
        c,
        "SELECT track_id FROM playlist_tracks WHERE playlist_id=?",
        [id],
    )?;
    let known: HashSet<_> = existing
        .iter()
        .map(|v| v["track_id"].as_str().unwrap())
        .collect();
    let incoming: Vec<_> = tracks
        .iter()
        .filter(|v| !known.contains(v["id"].as_str().unwrap()))
        .collect();
    if !incoming.is_empty() && existing.len() + incoming.len() > 5000 {
        return Err(ApiError::limit());
    }
    let pos: i64 = c.query_row(
        "SELECT COALESCE(max(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?",
        [id],
        |r| r.get(0),
    )?;
    for (offset, t) in incoming.iter().enumerate() {
        c.execute(
            "INSERT INTO playlist_tracks VALUES (?,?,?,?,?)",
            params![
                id,
                t["id"].as_str().unwrap(),
                t.to_string(),
                at,
                pos + offset as i64
            ],
        )?;
    }
    Ok(incoming.len())
}
pub fn favorite(
    c: &mut Connection,
    user: &str,
    id: &str,
    body: Value,
    delete: bool,
) -> Result<Value> {
    reference(id)?;
    if delete {
        return change(c, user, |c| {
            Ok((
                c.execute(
                    "DELETE FROM favorites WHERE user_id=? AND track_id=?",
                    params![user, id],
                )? > 0,
                json!({}),
            ))
        });
    }
    if body["track"]["id"] != id {
        return Err(ApiError::invalid("track.id must match the route."));
    }
    let t = track(&body["track"])?;
    change(c, user, |c| {
        if let Some(old) = one(
            c,
            "SELECT added_at FROM favorites WHERE user_id=? AND track_id=?",
            params![user, id],
        )? {
            return Ok((false, json!({"addedAt":old["added_at"]})));
        }
        if count(c, "SELECT count(*) FROM favorites WHERE user_id=?", user)? >= 5000 {
            return Err(ApiError::limit());
        }
        let at = db::now();
        let pos: i64 = c.query_row(
            "SELECT COALESCE(min(position),0)-1 FROM favorites WHERE user_id=?",
            [user],
            |r| r.get(0),
        )?;
        c.execute(
            "INSERT INTO favorites VALUES (?,?,?,?,?)",
            params![user, id, t.to_string(), at, pos],
        )?;
        Ok((true, json!({"addedAt":at})))
    })
}
pub fn create_playlist(c: &mut Connection, user: &str, body: Value) -> Result<Value> {
    let title = name(&body)?;
    let values = tracks(body.get("tracks"))?;
    if values.len() > 5000 {
        return Err(ApiError::limit());
    }
    change(c, user, |c| {
        if count(c, "SELECT count(*) FROM playlists WHERE user_id=?", user)? >= 200 {
            return Err(ApiError::limit());
        }
        let id = format!("u{}", uuid::Uuid::new_v4().simple());
        let at = db::now();
        c.execute(
            "INSERT INTO playlists VALUES (?,?,?,?,?)",
            params![id, user, title, at, at],
        )?;
        insert_tracks(c, &id, &values, at)?;
        Ok((true, json!({"playlist":playlist(c,user,&id)?})))
    })
}
pub fn playlist_action(
    c: &mut Connection,
    user: &str,
    id: &str,
    action: &str,
    track_id: Option<&str>,
    method: &str,
    body: Value,
) -> Result<Value> {
    if action.is_empty() && method == "GET" {
        return Ok(json!({"rev":rev(c,user)?,"playlist":playlist(c,user,id)?}));
    }
    change(c, user, |c| {
        let p = owned(c, user, id)?;
        match (action, method, track_id) {
            ("", "DELETE", _) => {
                c.execute("DELETE FROM playlists WHERE id=?", [id])?;
                Ok((true, json!({})))
            }
            ("", "PATCH", _) => {
                let title = name(&body)?;
                let changed = p["name"] != title;
                if changed {
                    c.execute(
                        "UPDATE playlists SET name=?,updated_at=max(?,updated_at+1) WHERE id=?",
                        params![title, db::now(), id],
                    )?;
                }
                let row = playlist_rows(c, user)?
                    .into_iter()
                    .find(|v| v["id"] == id)
                    .unwrap();
                Ok((changed, json!({"playlist":row})))
            }
            ("tracks", "POST", None) => {
                if !body["tracks"].is_array() {
                    return Err(ApiError::invalid("tracks must be an array."));
                }
                let n = insert_tracks(c, id, &tracks(body.get("tracks"))?, db::now())?;
                if n > 0 {
                    bump(c, id)?;
                }
                Ok((n > 0, json!({"added":n})))
            }
            ("tracks", "DELETE", Some(track_id)) => {
                reference(track_id)?;
                let changed = c.execute(
                    "DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?",
                    params![id, track_id],
                )? > 0;
                if changed {
                    bump(c, id)?;
                }
                Ok((changed, json!({})))
            }
            ("order", "PUT", None) => {
                if body
                    .get("expectedRev")
                    .is_some_and(|r| r != &json!(rev(c, user).unwrap_or(-1)))
                {
                    return Err(ApiError::conflict(
                        "REVISION_CONFLICT",
                        json!({"playlist":playlist(c,user,id)?}),
                    ));
                }
                let current: Vec<String> = rows(
                    c,
                    "SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position",
                    [id],
                )?
                .iter()
                .map(|v| v["track_id"].as_str().unwrap().into())
                .collect();
                let values = body["trackIds"].as_array().ok_or_else(|| {
                    ApiError::conflict(
                        "ORDER_MISMATCH",
                        json!({"playlist":playlist(c,user,id).unwrap_or(Value::Null)}),
                    )
                })?;
                let valid = values
                    .iter()
                    .all(|v| v.as_str().is_some_and(|s| current.iter().any(|i| i == s)));
                let unique: HashSet<_> = values.iter().filter_map(Value::as_str).collect();
                if !valid || values.len() != current.len() || unique.len() != current.len() {
                    return Err(ApiError::conflict(
                        "ORDER_MISMATCH",
                        json!({"playlist":playlist(c,user,id)?}),
                    ));
                }
                let changed = values.iter().zip(&current).any(|(a, b)| a != b);
                if changed {
                    for (i, t) in values.iter().enumerate() {
                        c.execute("UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?",params![i as i64,id,t.as_str().unwrap()])?;
                    }
                    bump(c, id)?;
                }
                Ok((changed, json!({})))
            }
            _ => Err(ApiError::missing()),
        }
    })
}
pub fn follow(
    c: &mut Connection,
    user: &str,
    id: &str,
    body: Value,
    delete: bool,
) -> Result<Value> {
    let provider = reference(id)?;
    if delete {
        return change(c, user, |c| {
            Ok((
                c.execute(
                    "DELETE FROM follows WHERE user_id=? AND artist_id=?",
                    params![user, id],
                )? > 0,
                json!({}),
            ))
        });
    }
    let n = body["name"].as_str().unwrap_or("");
    if n.trim().is_empty() || n.encode_utf16().count() > 300 {
        return Err(ApiError::invalid("An artist name is required."));
    }
    let n = n.trim();
    let image = body["imageUrl"].as_str().unwrap_or("");
    if !image.is_empty() && !local_image(image) {
        return Err(ApiError::invalid(
            "Artwork must belong to the DoubleMusic catalog.",
        ));
    }
    change(c, user, |c| {
        let old = one(
            c,
            "SELECT * FROM follows WHERE user_id=? AND artist_id=?",
            params![user, id],
        )?;
        if old.is_none() && count(c, "SELECT count(*) FROM follows WHERE user_id=?", user)? >= 100 {
            return Err(ApiError::limit());
        }
        let changed = old
            .as_ref()
            .is_none_or(|v| v["name"] != n || v["image_url"] != image);
        let at = old
            .as_ref()
            .and_then(|v| v["added_at"].as_i64())
            .unwrap_or_else(db::now);
        if changed {
            c.execute("INSERT INTO follows VALUES (?,?,?,?,?) ON CONFLICT(user_id,artist_id) DO UPDATE SET name=excluded.name,image_url=excluded.image_url",params![user,id,n,image,at])?;
        }
        Ok((
            changed,
            json!({"entry":{"id":id,"name":n,"imageUrl":image,"addedAt":at,"provider":provider}}),
        ))
    })
}
pub fn save(
    c: &mut Connection,
    user: &str,
    id: &str,
    kind: &str,
    snapshot: Option<Value>,
) -> Result<Value> {
    // Table/column names come only from this fixed dispatch, never request text.
    let (table, col) = if kind == "albums" {
        ("saved_albums", "album_id")
    } else {
        ("saved_playlists", "playlist_id")
    };
    change(c, user, |c| {
        let exists = one(
            c,
            &format!("SELECT 1 FROM {table} WHERE user_id=? AND {col}=?"),
            params![user, id],
        )?
        .is_some();
        let Some(snapshot) = snapshot else {
            return Ok((
                c.execute(
                    &format!("DELETE FROM {table} WHERE user_id=? AND {col}=?"),
                    params![user, id],
                )? > 0,
                json!({}),
            ));
        };
        if exists {
            return Ok((false, json!({})));
        }
        if count(
            c,
            &format!("SELECT count(*) FROM {table} WHERE user_id=?"),
            user,
        )? >= 200
        {
            return Err(ApiError::limit());
        }
        c.execute(
            &format!("INSERT INTO {table} VALUES (?,?,?,?)"),
            params![user, id, snapshot.to_string(), db::now()],
        )?;
        Ok((true, json!({})))
    })
}

pub fn import_library(c: &mut Connection, user: &str, body: Value) -> Result<Value> {
    let source = body["source"].as_str().unwrap_or("");
    let device = body["deviceId"].as_str().unwrap_or("");
    let valid_local = |s: &str, max: usize| {
        !s.is_empty()
            && s.len() <= max
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    };
    if !["ios", "android", "web"].contains(&source) || !valid_local(device, 64) {
        return Err(ApiError::invalid("Invalid source or deviceId."));
    }
    let duplicate = |c: &Connection| -> Result<bool> {
        Ok(one(
            c,
            "SELECT 1 FROM imports WHERE user_id=? AND source=? AND device_id=?",
            params![user, source, device],
        )?
        .is_some())
    };
    if duplicate(c)? {
        return Ok(
            json!({"rev":rev(c,user)?,"alreadyImported":true,"favoritesAdded":0,"playlistsCreated":0}),
        );
    }
    let favorites = tracks(body.get("favorites"))?;
    let mut playlists = vec![];
    let mut ids = HashSet::new();
    if let Some(v) = body.get("playlists") {
        for p in v
            .as_array()
            .ok_or_else(|| ApiError::invalid("playlists must be an array."))?
        {
            let id = p["id"].as_str().unwrap_or("");
            if !valid_local(id, 120) || !ids.insert(id.to_string()) {
                return Err(ApiError::invalid(
                    "Invalid or duplicate local playlist IDs.",
                ));
            }
            playlists.push((id.to_string(), name(p)?, tracks(p.get("tracks"))?));
        }
    }
    change(c, user, |c| {
        if duplicate(c)? {
            return Ok((
                false,
                json!({"alreadyImported":true,"favoritesAdded":0,"playlistsCreated":0}),
            ));
        }
        let current = rows(c, "SELECT track_id FROM favorites WHERE user_id=?", [user])?;
        let known: HashSet<_> = current
            .iter()
            .filter_map(|v| v["track_id"].as_str())
            .collect();
        let incoming: Vec<_> = favorites
            .iter()
            .filter(|t| !known.contains(t["id"].as_str().unwrap()))
            .collect();
        if !incoming.is_empty() && current.len() + incoming.len() > 5000 {
            return Err(ApiError::limit());
        }
        let position: i64 = c.query_row(
            "SELECT COALESCE(max(position),-1)+1 FROM favorites WHERE user_id=?",
            [user],
            |r| r.get(0),
        )?;
        let at = db::now();
        for (offset, t) in incoming.iter().enumerate() {
            c.execute(
                "INSERT INTO favorites VALUES (?,?,?,?,?)",
                params![
                    user,
                    t["id"].as_str().unwrap(),
                    t.to_string(),
                    at,
                    position + offset as i64
                ],
            )?;
        }
        let mut created = 0;
        for (local, title, values) in playlists {
            let existing = one(
                c,
                "SELECT playlist_id FROM playlist_imports WHERE user_id=? AND source=? AND local_id=?",
                params![user, source, local],
            )?;
            let id = if let Some(p) = existing {
                p["playlist_id"].as_str().unwrap().to_string()
            } else {
                if count(c, "SELECT count(*) FROM playlists WHERE user_id=?", user)? >= 200 {
                    return Err(ApiError::limit());
                }
                let id = format!("u{}", uuid::Uuid::new_v4().simple());
                c.execute(
                    "INSERT INTO playlists VALUES (?,?,?,?,?)",
                    params![id, user, title, at, at],
                )?;
                c.execute(
                    "INSERT INTO playlist_imports VALUES (?,?,?,?)",
                    params![user, source, local, id],
                )?;
                created += 1;
                id
            };
            if insert_tracks(c, &id, &values, at)? > 0 {
                bump(c, &id)?;
            }
        }
        c.execute(
            "INSERT INTO imports VALUES (?,?,?)",
            params![user, source, device],
        )?;
        Ok((
            true,
            json!({"alreadyImported":false,"favoritesAdded":incoming.len(),"playlistsCreated":created}),
        ))
    })
}
