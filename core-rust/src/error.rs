use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub type Result<T> = std::result::Result<T, ApiError>;
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Box<Value>>,
}
impl ApiError {
    pub fn new(status: u16, code: impl Into<String>) -> Self {
        let code = code.into();
        Self {
            status,
            message: match code.as_str() {
                "UNAUTHENTICATED" => "Sign in to use DoubleMusic.",
                "INVALID_CREDENTIALS" => "Incorrect username or password.",
                "LOGIN_BLOCKED" => "Too many attempts. Wait one minute.",
                "ADMIN_REQUIRED" => "Administrator access required.",
                "INTERNAL_ERROR" => "Could not complete the request.",
                "CATALOG_UNAVAILABLE" => "The catalog worker is unavailable.",
                _ => &code,
            }
            .to_string(),
            code,
            details: None,
        }
    }
    pub fn invalid(message: &str) -> Self {
        Self {
            message: message.into(),
            ..Self::new(400, "INVALID_BODY")
        }
    }
    pub fn missing() -> Self {
        Self::new(404, "NOT_FOUND")
    }
    pub fn unauthenticated() -> Self {
        Self::new(401, "UNAUTHENTICATED")
    }
    pub fn limit() -> Self {
        Self::new(413, "LIMIT_REACHED")
    }
    pub fn conflict(code: &'static str, details: Value) -> Self {
        Self {
            details: Some(Box::new(details)),
            ..Self::new(409, code)
        }
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        // Log the category only: SQL values, tokens and passwords must not enter logs.
        eprintln!("Rust core database error: {:?}", error.sqlite_error_code());
        Self::new(500, "INTERNAL_ERROR")
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({"error":self.code,"message":self.message});
        let mut allow = None;
        if let Some(details) = self.details
            && let Value::Object(mut details) = *details
        {
            allow = details.remove("allowed").and_then(|v| {
                v.as_array().map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
            });
            body.as_object_mut().unwrap().extend(details);
        }
        let mut res = (StatusCode::from_u16(self.status).unwrap(), Json(body)).into_response();
        if let Some(allow) = allow {
            res.headers_mut().insert("allow", allow.parse().unwrap());
        }
        if self.status == 429 {
            res.headers_mut()
                .insert("retry-after", "60".parse().unwrap());
        }
        if self.status == 413 {
            res.headers_mut()
                .insert("connection", "close".parse().unwrap());
        }
        res
    }
}
