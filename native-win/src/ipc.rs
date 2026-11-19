use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

use crate::win32::{resolve_normalized_dir, to_wide};

pub fn compute_ipc_endpoint(state_dir: &Path) -> String {
    let normalized = resolve_normalized_dir(state_dir);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("\\\\.\\pipe\\gravitybox-{}", &digest[..20])
}

pub fn rpc_call(
    endpoint: &str,
    command: &str,
    payload: Value,
    timeout_ms: u64,
) -> Result<Value, String> {
    let endpoint_owned = endpoint.to_string();
    let mut body = match payload {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    body.insert("command".to_string(), Value::String(command.to_string()));
    let line = serde_json::to_string(&Value::Object(body)).map_err(|e| e.to_string())? + "\n";

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let res = send_pipe_request(&endpoint_owned, &line, Duration::from_millis(timeout_ms));
        let _ = tx.send(res);
    });

    rx.recv_timeout(Duration::from_millis(timeout_ms))
        .map_err(|_| "IPC timeout".to_string())?
}

fn send_pipe_request(endpoint: &str, line: &str, budget: Duration) -> Result<Value, String> {
    let start = Instant::now();
    let w_name = to_wide(endpoint);

    let mut file = loop {
        match OpenOptions::new().read(true).write(true).open(endpoint) {
            Ok(f) => break f,
            Err(e) => {
                if start.elapsed() >= budget {
                    return Err(format!("Cannot connect to backend pipe: {e}"));
                }
                let raw = e.raw_os_error().unwrap_or(0);
                // ERROR_PIPE_BUSY (231) or ERROR_FILE_NOT_FOUND (2) while booting
                if raw == 231 {
                    unsafe {
                        WaitNamedPipeW(w_name.as_ptr(), 300);
                    }
                } else {
                    thread::sleep(Duration::from_millis(80));
                }
            }
        }
    };

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed writing IPC request: {e}"))?;
    file.flush()
        .map_err(|e| format!("Failed flushing IPC request: {e}"))?;

    let mut reader = BufReader::new(file);
    let mut reply_line = String::new();
    let n = reader
        .read_line(&mut reply_line)
        .map_err(|e| format!("Failed reading IPC reply: {e}"))?;
    if n == 0 {
        return Err("Empty IPC response".to_string());
    }
    serde_json::from_str(reply_line.trim()).map_err(|e| format!("Invalid IPC JSON: {e}"))
}
