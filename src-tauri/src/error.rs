use serde::Serialize;
use std::fmt::{Display, Formatter};

pub type AppResult<T> = Result<T, AppError>;

/// The only error shape exposed across the native/frontend boundary.
/// Platform errors are deliberately translated to stable public messages so
/// credential data and machine-specific details never reach IPC responses.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl Display for AppError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn public_error_has_stable_serializable_shape() {
        let error = AppError::new("INVALID_INPUT", "输入格式不正确。");
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "code": "INVALID_INPUT",
                "message": "输入格式不正确。",
            })
        );
    }
}
