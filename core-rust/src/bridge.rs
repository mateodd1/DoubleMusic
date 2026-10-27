//! Streaming bridge to the private catalog worker, never directly to an external source.
//! Redirects are forbidden so credentials cannot follow an upstream Location.
use crate::error::{ApiError, Result};
use axum::{body::Body, extract::Request, http::HeaderMap, response::Response};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct Bridge {
    origin: String,
    client: reqwest::Client,
}
fn clean_headers(headers: &HeaderMap) -> HeaderMap {
    let mut out = headers.clone();
    let nominated: Vec<String> = headers
        .get_all("connection")
        .iter()
        .filter_map(|s| s.to_str().ok())
        .flat_map(|s| s.split(','))
        .map(|s| s.trim().to_string())
        .collect();
    for k in nominated {
        out.remove(k);
    }
    for k in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "x-core-runtime",
    ] {
        out.remove(k);
    }
    out
}
impl Bridge {
    pub fn new(origin: String) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let parsed = url::Url::parse(&origin)?;
        if parsed.scheme() != "http"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(
                "CATALOG_ORIGIN must be a trusted private HTTP origin without a path".into(),
            );
        }
        Ok(Self {
            origin: origin.trim_end_matches('/').to_string(),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .read_timeout(Duration::from_secs(300))
                .pool_idle_timeout(Duration::from_secs(60))
                .build()?,
        })
    }
    pub async fn json(&self, path: &str, token: &str) -> Result<Value> {
        let response = self
            .client
            .get(format!("{}{path}", self.origin))
            .bearer_auth(token)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| ApiError::new(502, "CATALOG_UNAVAILABLE"))?;
        let status = response.status();
        // The peer is trusted but cap snapshots and reject malformed JSON.
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ApiError::new(502, "CATALOG_UNAVAILABLE"))?;
            if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
                return Err(ApiError::new(502, "PROVIDER_INVALID_RESPONSE"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::new(502, "PROVIDER_INVALID_RESPONSE"))?;
        if !status.is_success() {
            if !status.is_client_error() && !status.is_server_error() {
                return Err(ApiError::new(502, "CATALOG_UNAVAILABLE"));
            }
            let code = value["error"]
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                })
                .unwrap_or("CATALOG_UNAVAILABLE");
            let mut error = ApiError::new(status.as_u16(), code);
            if let Some(message) = value["message"].as_str() {
                error.message = message.to_string();
            }
            return Err(error);
        }
        Ok(value)
    }
    pub async fn proxy(&self, request: Request) -> Result<Response> {
        let (parts, body) = request.into_parts();
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/");
        let response = self
            .client
            .request(parts.method, format!("{}{path}", self.origin))
            .headers(clean_headers(&parts.headers))
            .body(reqwest::Body::wrap_stream(body.into_data_stream()))
            .send()
            .await
            .map_err(|_| ApiError::new(502, "CATALOG_UNAVAILABLE"))?;
        let status = response.status();
        let headers = clean_headers(response.headers());
        let mut out = Response::new(Body::from_stream(response.bytes_stream()));
        *out.status_mut() = status;
        *out.headers_mut() = headers;
        Ok(out)
    }
}
