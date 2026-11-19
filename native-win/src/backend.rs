use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::json;

use crate::ipc::rpc_call;
use crate::win32::CREATE_NO_WINDOW;

pub struct BackendSupervisor {
    resource_root: PathBuf,
    state_dir: PathBuf,
    log_dir: PathBuf,
    ipc_endpoint: String,
    child: Mutex<Option<Child>>,
    quitting: AtomicBool,
}

impl BackendSupervisor {
    pub fn new(resource_root: PathBuf, state_dir: PathBuf, log_dir: PathBuf, ipc_endpoint: String) -> Self {
        Self {
            resource_root,
            state_dir,
            log_dir,
            ipc_endpoint,
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
        }
    }

    pub fn is_alive(&self) -> bool {
        matches!(
            rpc_call(&self.ipc_endpoint, "ping", json!({}), 1200),
            Ok(v) if v.get("ok").and_then(|b| b.as_bool()) == Some(true)
        )
    }

    fn find_node_exe(&self) -> PathBuf {
        let local_candidates = [
            self.resource_root.join("node.exe"),
            self.resource_root.join("resources").join("node.exe"),
        ];
        for c in local_candidates {
            if c.is_file() {
                return c;
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let p = dir.join("node.exe");
                if p.is_file() {
                    return p;
                }
            }
        }
        PathBuf::from("node.exe")
    }

    pub fn spawn_if_needed(self: &Arc<Self>, locale: &str, system_locale: &str) {
        if self.quitting.load(Ordering::Relaxed) {
            return;
        }
        let mut guard = self.child.lock().unwrap();
        if let Some(ref mut ch) = *guard {
            if let Ok(None) = ch.try_wait() {
                return;
            }
        }
        let entry = self.resource_root.join("dist").join("main.js");
        if !entry.is_file() {
            self.append_log(&format!("[Supervisor] missing backend entry: {}", entry.display()));
            return;
        }
        let node_bin = self.find_node_exe();
        let mut cmd = Command::new(&node_bin);
        cmd.arg(&entry)
            .arg("--state-dir")
            .arg(&self.state_dir)
            .arg("--locale")
            .arg(locale)
            .arg("--system-locales")
            .arg(system_locale)
            .current_dir(&self.resource_root)
            .env("ELECTRON_NO_ASAR", "1")
            .env("GRAVITYBOX_NODE_BINARY", &node_bin)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);

        match cmd.spawn() {
            Ok(mut child) => {
                if let Some(stderr) = child.stderr.take() {
                    let log_dir = self.log_dir.clone();
                    thread::spawn(move || {
                        use std::io::{BufRead, BufReader};
                        let reader = BufReader::new(stderr);
                        for line in reader.lines().map_while(Result::ok) {
                            if !line.contains("ExperimentalWarning") {
                                write_log_line(&log_dir, &format!("[Backend] {line}"));
                            }
                        }
                    });
                }
                *guard = Some(child);
            }
            Err(e) => {
                self.append_log(&format!("[Supervisor] spawn failed ({}): {e}", node_bin.display()));
            }
        }
    }

    pub fn ensure_running(self: &Arc<Self>, locale: &str, system_locale: &str) {
        if self.is_alive() {
            return;
        }
        self.spawn_if_needed(locale, system_locale);
        for _ in 0..45 {
            if self.quitting.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(Duration::from_millis(150));
            if self.is_alive() {
                return;
            }
        }
    }

    pub fn stop_gracefully(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        let _ = rpc_call(&self.ipc_endpoint, "stop", json!({}), 2000);
        thread::sleep(Duration::from_millis(300));
        let mut guard = self.child.lock().unwrap();
        if let Some(ref mut ch) = *guard {
            if let Ok(None) = ch.try_wait() {
                let _ = ch.kill();
                let _ = ch.wait();
            }
        }
        *guard = None;
    }

    pub fn read_recent_logs(&self) -> String {
        let log_file = self.log_dir.join("backend.log");
        let text = fs::read_to_string(log_file).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(200);
        lines[start..].join("\n")
    }

    fn append_log(&self, line: &str) {
        write_log_line(&self.log_dir, line);
    }
}

fn write_log_line(log_dir: &Path, line: &str) {
    let _ = fs::create_dir_all(log_dir);
    let path = log_dir.join("backend.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}
