use std::collections::HashSet;
use std::ffi::OsStr;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HGLOBAL, HWND, LPARAM, RECT,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_SZ,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, INFINITE,
};
use windows_sys::Win32::UI::Controls::Dialogs::{
    GetSaveFileNameW, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SetForegroundWindow,
    ShowWindow, SystemParametersInfoW, SPI_GETWORKAREA, SW_RESTORE, SW_SHOW, WM_CLOSE,
};

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CF_UNICODETEXT: u32 = 13;
const EVENT_MODIFY_STATE: u32 = 0x0002;
const SHOW_MAIN_EVENT_NAME: &str = "Local\\GravityBoxShowMainEvent";
const MUTEX_NAME: &str = "Local\\GravityBoxSingleInstanceMutex";
const RUN_REG_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE_NAME: &str = "GravityBox";

pub fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub fn from_wide_nul(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

pub fn system_locale_name() -> String {
    let mut buf = [0u16; 85];
    let n = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    if n > 1 {
        from_wide_nul(&buf)
    } else {
        "zh-CN".to_string()
    }
}

pub fn acquire_single_instance_or_signal() -> Option<HANDLE> {
    let mutex_name = to_wide(MUTEX_NAME);
    unsafe {
        let h_mutex = CreateMutexW(ptr::null(), 0, mutex_name.as_ptr());
        if h_mutex.is_null() {
            return None;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let ev_name = to_wide(SHOW_MAIN_EVENT_NAME);
            let h_ev = OpenEventW(EVENT_MODIFY_STATE, 0, ev_name.as_ptr());
            if !h_ev.is_null() {
                SetEvent(h_ev);
                CloseHandle(h_ev);
            }
            CloseHandle(h_mutex);
            return None;
        }
        Some(h_mutex)
    }
}

pub fn start_show_main_event_listener<F>(on_trigger: F)
where
    F: Fn() + Send + 'static,
{
    thread::spawn(move || unsafe {
        let ev_name = to_wide(SHOW_MAIN_EVENT_NAME);
        let h_ev = CreateEventW(ptr::null(), 0, 0, ev_name.as_ptr());
        if h_ev.is_null() {
            return;
        }
        loop {
            if WaitForSingleObject(h_ev, INFINITE) == WAIT_OBJECT_0 {
                on_trigger();
            } else {
                break;
            }
        }
        CloseHandle(h_ev);
    });
}

pub fn work_area_rect() -> (i32, i32, i32, i32) {
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: 1280,
        bottom: 720,
    };
    unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            (&mut rc as *mut RECT).cast(),
            0,
        );
    }
    (rc.left, rc.top, rc.right, rc.bottom)
}

pub fn find_antigravity_exe() -> Option<PathBuf> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|h| PathBuf::from(h).join("AppData").join("Local"))
        });
    let prog_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
    let prog_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Program Files (x86)"));

    let mut candidates = Vec::new();
    if let Some(ref lad) = local_app_data {
        candidates.push(lad.join("Programs").join("antigravity").join("Antigravity.exe"));
        candidates.push(lad.join("Programs").join("Antigravity").join("Antigravity.exe"));
    }
    candidates.push(prog_files.join("Antigravity").join("Antigravity.exe"));
    candidates.push(prog_files_x86.join("Antigravity").join("Antigravity.exe"));

    candidates.into_iter().find(|p| p.is_file())
}

pub fn list_pids_by_exe_name(target_lower: &str) -> Vec<u32> {
    let mut pids = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == (-1isize as HANDLE) {
            return pids;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let name = from_wide_nul(&entry.szExeFile).to_lowercase();
                if name == target_lower {
                    pids.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    pids
}

struct EnumCtx {
    pids: HashSet<u32>,
    action_close: bool,
    activated: bool,
}

unsafe extern "system" fn enum_windows_cb(hwnd: HWND, lparam: LPARAM) -> i32 {
    let ctx = &mut *(lparam as *mut EnumCtx);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if !ctx.pids.contains(&pid) {
        return 1;
    }
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    if ctx.action_close {
        PostMessageW(hwnd, WM_CLOSE, 0, 0);
    } else if !ctx.activated {
        ShowWindow(hwnd, SW_RESTORE);
        SetForegroundWindow(hwnd);
        ctx.activated = true;
    }
    1
}

pub fn focus_running_antigravity() -> bool {
    let pids: HashSet<u32> = list_pids_by_exe_name("antigravity.exe").into_iter().collect();
    if pids.is_empty() {
        return false;
    }
    let mut ctx = EnumCtx {
        pids,
        action_close: false,
        activated: false,
    };
    unsafe {
        EnumWindows(Some(enum_windows_cb), (&mut ctx as *mut EnumCtx) as LPARAM);
    }
    ctx.activated
}

pub fn is_antigravity_running() -> bool {
    !list_pids_by_exe_name("antigravity.exe").is_empty()
}

pub fn close_antigravity_gracefully(timeout_ms: u64) -> bool {
    let pids = list_pids_by_exe_name("antigravity.exe");
    if pids.is_empty() {
        return true;
    }
    let mut ctx = EnumCtx {
        pids: pids.into_iter().collect(),
        action_close: true,
        activated: false,
    };
    unsafe {
        EnumWindows(Some(enum_windows_cb), (&mut ctx as *mut EnumCtx) as LPARAM);
    }

    let graceful_budget = Duration::from_millis(timeout_ms.min(3500));
    let start = Instant::now();
    while start.elapsed() < graceful_budget {
        if list_pids_by_exe_name("antigravity.exe").is_empty() {
            return true;
        }
        thread::sleep(Duration::from_millis(120));
    }

    // Helper/crashpad/extensionHost processes on Windows frequently linger after main window closes;
    // clean them up so files/SQLite locks are released and relaunch binds the debug port cleanly.
    let _ = Command::new("taskkill.exe")
        .args(["/IM", "Antigravity.exe", "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let extra_budget = Duration::from_millis(timeout_ms.saturating_sub(3500).max(2000));
    let cleanup_start = Instant::now();
    while cleanup_start.elapsed() < extra_budget {
        if list_pids_by_exe_name("antigravity.exe").is_empty() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    list_pids_by_exe_name("antigravity.exe").is_empty()
}

pub fn open_antigravity(remote_debug: bool) -> Result<(), String> {
    if !remote_debug && focus_running_antigravity() {
        return Ok(());
    }
    let Some(exe) = find_antigravity_exe() else {
        return Err("Antigravity executable not found".to_string());
    };
    let mut cmd = Command::new(&exe);
    if remote_debug {
        cmd.arg("--remote-debugging-port=0");
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch Antigravity: {e}"))
}

pub fn safe_relaunch_antigravity() -> Result<(), String> {
    if !close_antigravity_gracefully(9000) {
        return Err("Timed out waiting for Antigravity to exit".to_string());
    }
    thread::sleep(Duration::from_millis(450));
    open_antigravity(true)
}

pub fn shell_open(target: &str) {
    if target.is_empty() {
        return;
    }
    let op = to_wide("open");
    let file = to_wide(target);
    unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOW,
        );
    }
}

pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let wide = to_wide(text);
    let byte_len = wide.len() * std::mem::size_of::<u16>();
    unsafe {
        if OpenClipboard(ptr::null_mut()) == 0 {
            return Err("OpenClipboard failed".to_string());
        }
        EmptyClipboard();
        let h_mem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, byte_len);
        if h_mem.is_null() {
            CloseClipboard();
            return Err("GlobalAlloc failed".to_string());
        }
        let locked = GlobalLock(h_mem);
        if locked.is_null() {
            CloseClipboard();
            return Err("GlobalLock failed".to_string());
        }
        ptr::copy_nonoverlapping(wide.as_ptr(), locked as *mut u16, wide.len());
        GlobalUnlock(h_mem);
        SetClipboardData(CF_UNICODETEXT, h_mem as HANDLE);
        CloseClipboard();
    }
    Ok(())
}

pub fn save_json_dialog(default_name: &str) -> Option<PathBuf> {
    let mut buf = [0u16; 1024];
    let def_w: Vec<u16> = OsStr::new(default_name).encode_wide().collect();
    let copy_len = def_w.len().min(buf.len() - 1);
    buf[..copy_len].copy_from_slice(&def_w[..copy_len]);

    let filter: Vec<u16> = OsStr::new("JSON (*.json)\0*.json\0All Files (*.*)\0*.*\0\0")
        .encode_wide()
        .collect();
    let def_ext = to_wide("json");

    let mut ofn: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.nFilterIndex = 1;
    ofn.lpstrFile = buf.as_mut_ptr();
    ofn.nMaxFile = buf.len() as u32;
    ofn.lpstrDefExt = def_ext.as_ptr();
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;

    let ok = unsafe { GetSaveFileNameW(&mut ofn) };
    if ok != 0 {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let os = std::ffi::OsString::from_wide(&buf[..len]);
        Some(PathBuf::from(os))
    } else {
        None
    }
}

pub fn get_login_item() -> bool {
    let subkey = to_wide(RUN_REG_PATH);
    let val_name = to_wide(RUN_VALUE_NAME);
    unsafe {
        let mut hkey = ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return false;
        }
        let mut size: u32 = 0;
        let rc = RegQueryValueExW(
            hkey,
            val_name.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut size,
        );
        RegCloseKey(hkey);
        rc == 0 && size > 0
    }
}

pub fn set_login_item(enabled: bool) -> bool {
    let subkey = to_wide(RUN_REG_PATH);
    let val_name = to_wide(RUN_VALUE_NAME);
    unsafe {
        let mut hkey = ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_WRITE, &mut hkey) != 0 {
            return get_login_item();
        }
        if enabled {
            if let Ok(exe) = std::env::current_exe() {
                let cmd_line = format!("\"{}\" --tray", exe.display());
                let w = to_wide(&cmd_line);
                let byte_len = (w.len() * std::mem::size_of::<u16>()) as u32;
                RegSetValueExW(
                    hkey,
                    val_name.as_ptr(),
                    0,
                    REG_SZ,
                    w.as_ptr() as *const u8,
                    byte_len,
                );
            }
        } else {
            RegDeleteValueW(hkey, val_name.as_ptr());
        }
        RegCloseKey(hkey);
    }
    get_login_item()
}

pub fn resolve_normalized_dir(p: &Path) -> String {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    let s = abs.to_string_lossy().replace('/', "\\");
    s.trim_end_matches('\\').to_lowercase()
}
