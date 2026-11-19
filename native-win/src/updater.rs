use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpAddRequestHeaders, WinHttpCloseHandle, WinHttpConnect, WinHttpCrackUrl, WinHttpOpen,
    WinHttpOpenRequest, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts, URL_COMPONENTS, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
    WINHTTP_ADDREQ_FLAG_ADD, WINHTTP_ADDREQ_FLAG_REPLACE, WINHTTP_FLAG_SECURE,
    WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
};

use crate::win32::to_wide;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub state: String,
    pub current_version: String,
    pub latest_tag: Option<String>,
    pub published_at: Option<String>,
    pub release_url: Option<String>,
    pub notes: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub sha256_url: Option<String>,
    pub downloaded_path: Option<String>,
    pub progress: u32,
    pub error: Option<String>,
}

impl UpdateState {
    pub fn initial(current_version: &str) -> Self {
        Self {
            state: "idle".to_string(),
            current_version: current_version.to_string(),
            latest_tag: None,
            published_at: None,
            release_url: None,
            notes: String::new(),
            asset_name: None,
            asset_url: None,
            sha256_url: None,
            downloaded_path: None,
            progress: 0,
            error: None,
        }
    }
}

pub fn compare_semver(a: &str, b: &str) -> i32 {
    let parse = |s: &str| -> [u64; 3] {
        let clean = s.trim().trim_start_matches(['v', 'V']);
        let main = clean.split('-').next().unwrap_or("");
        let mut nums = [0u64; 3];
        for (i, part) in main.split('.').take(3).enumerate() {
            nums[i] = part.parse::<u64>().unwrap_or(0);
        }
        nums
    };
    let pa = parse(a);
    let pb = parse(b);
    for i in 0..3 {
        if pa[i] > pb[i] {
            return 1;
        }
        if pa[i] < pb[i] {
            return -1;
        }
    }
    0
}

struct ParsedUrl {
    host: String,
    port: u16,
    path_and_query: String,
    is_https: bool,
}

fn crack_url(url: &str) -> Result<ParsedUrl, String> {
    let w_url = to_wide(url);
    let mut host_buf = [0u16; 512];
    let mut path_buf = [0u16; 2048];
    let mut extra_buf = [0u16; 1024];
    let mut scheme_buf = [0u16; 32];

    let mut comps: URL_COMPONENTS = unsafe { std::mem::zeroed() };
    comps.dwStructSize = std::mem::size_of::<URL_COMPONENTS>() as u32;
    comps.lpszScheme = scheme_buf.as_mut_ptr();
    comps.dwSchemeLength = scheme_buf.len() as u32;
    comps.lpszHostName = host_buf.as_mut_ptr();
    comps.dwHostNameLength = host_buf.len() as u32;
    comps.lpszUrlPath = path_buf.as_mut_ptr();
    comps.dwUrlPathLength = path_buf.len() as u32;
    comps.lpszExtraInfo = extra_buf.as_mut_ptr();
    comps.dwExtraInfoLength = extra_buf.len() as u32;

    let ok = unsafe { WinHttpCrackUrl(w_url.as_ptr(), 0, 0, &mut comps) };
    if ok == 0 {
        return Err("Invalid URL".to_string());
    }
    let scheme = String::from_utf16_lossy(&scheme_buf[..comps.dwSchemeLength as usize]);
    let host = String::from_utf16_lossy(&host_buf[..comps.dwHostNameLength as usize]);
    let path = String::from_utf16_lossy(&path_buf[..comps.dwUrlPathLength as usize]);
    let extra = String::from_utf16_lossy(&extra_buf[..comps.dwExtraInfoLength as usize]);
    let is_https = scheme.eq_ignore_ascii_case("https");
    let port = if comps.nPort == 0 {
        if is_https { 443 } else { 80 }
    } else {
        comps.nPort
    };
    let mut full_path = if path.is_empty() { "/".to_string() } else { path };
    full_path.push_str(&extra);
    Ok(ParsedUrl {
        host,
        port,
        path_and_query: full_path,
        is_https,
    })
}

fn http_get_stream<F>(
    url: &str,
    headers: &str,
    cancel: Option<&AtomicBool>,
    mut on_chunk: F,
) -> Result<(u32, Option<u64>), String>
where
    F: FnMut(&[u8], Option<u64>) -> Result<(), String>,
{
    let parsed = crack_url(url)?;
    let agent = to_wide("GravityBox-Updater");
    let h_session = unsafe {
        WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            ptr::null(),
            ptr::null(),
            0,
        )
    };
    if h_session.is_null() {
        return Err("WinHttpOpen failed".to_string());
    }
    unsafe {
        WinHttpSetTimeouts(h_session, 10_000, 15_000, 15_000, 60_000);
    }

    let w_host = to_wide(&parsed.host);
    let h_connect = unsafe { WinHttpConnect(h_session, w_host.as_ptr(), parsed.port, 0) };
    if h_connect.is_null() {
        unsafe { WinHttpCloseHandle(h_session) };
        return Err("WinHttpConnect failed".to_string());
    }

    let w_verb = to_wide("GET");
    let w_path = to_wide(&parsed.path_and_query);
    let flags = if parsed.is_https { WINHTTP_FLAG_SECURE } else { 0 };
    let h_req = unsafe {
        WinHttpOpenRequest(
            h_connect,
            w_verb.as_ptr(),
            w_path.as_ptr(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            flags,
        )
    };
    if h_req.is_null() {
        unsafe {
            WinHttpCloseHandle(h_connect);
            WinHttpCloseHandle(h_session);
        }
        return Err("WinHttpOpenRequest failed".to_string());
    }

    if !headers.is_empty() {
        let w_hdr = to_wide(headers);
        unsafe {
            WinHttpAddRequestHeaders(
                h_req,
                w_hdr.as_ptr(),
                u32::MAX,
                WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE,
            );
        }
    }

    let sent = unsafe { WinHttpSendRequest(h_req, ptr::null(), 0, ptr::null(), 0, 0, 0) };
    let recvd = if sent != 0 {
        unsafe { WinHttpReceiveResponse(h_req, ptr::null_mut()) }
    } else {
        0
    };
    if recvd == 0 {
        unsafe {
            WinHttpCloseHandle(h_req);
            WinHttpCloseHandle(h_connect);
            WinHttpCloseHandle(h_session);
        }
        return Err("Network request failed".to_string());
    }

    let mut status_code: u32 = 0;
    let mut len: u32 = std::mem::size_of::<u32>() as u32;
    unsafe {
        WinHttpQueryHeaders(
            h_req,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            ptr::null(),
            (&mut status_code as *mut u32).cast(),
            &mut len,
            ptr::null_mut(),
        );
    }

    let mut cl_val: u32 = 0;
    let mut cl_len: u32 = std::mem::size_of::<u32>() as u32;
    let total_bytes = if unsafe {
        WinHttpQueryHeaders(
            h_req,
            WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
            ptr::null(),
            (&mut cl_val as *mut u32).cast(),
            &mut cl_len,
            ptr::null_mut(),
        )
    } != 0
    {
        Some(u64::from(cl_val))
    } else {
        None
    };

    let mut buf = [0u8; 32768];
    let mut read_res: Result<(), String> = Ok(());
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            read_res = Err("Cancelled".to_string());
            break;
        }
        let mut bytes_read: u32 = 0;
        let ok = unsafe {
            WinHttpReadData(
                h_req,
                buf.as_mut_ptr().cast(),
                buf.len() as u32,
                &mut bytes_read,
            )
        };
        if ok == 0 {
            read_res = Err("WinHttpReadData failed".to_string());
            break;
        }
        if bytes_read == 0 {
            break;
        }
        if let Err(e) = on_chunk(&buf[..bytes_read as usize], total_bytes) {
            read_res = Err(e);
            break;
        }
    }

    unsafe {
        WinHttpCloseHandle(h_req);
        WinHttpCloseHandle(h_connect);
        WinHttpCloseHandle(h_session);
    }
    read_res?;
    Ok((status_code, total_bytes))
}

fn http_get_text(url: &str, headers: &str) -> Result<(u32, String), String> {
    let mut body = Vec::new();
    let (status, _) = http_get_stream(url, headers, None, |chunk, _| {
        if body.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("Response too large".to_string());
        }
        body.extend_from_slice(chunk);
        Ok(())
    })?;
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

pub fn fetch_latest_release(repo_slug: &str, current_version: &str) -> Result<UpdateState, String> {
    let url = format!("https://api.github.com/repos/{repo_slug}/releases/latest");
    let (status, body) = http_get_text(&url, "Accept: application/vnd.github+json\r\n")?;
    if status < 200 || status >= 300 {
        return Err(format!("GitHub HTTP {status}"));
    }
    let rel: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let tag = rel
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let published_at = rel
        .get("published_at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let release_url = rel
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let notes = rel
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let assets = rel
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let setup_asset = assets.iter().find(|a| {
        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        name.ends_with(".exe") && name.contains("setup")
    });
    let sha_asset = setup_asset.and_then(|setup| {
        let setup_name = setup.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        assets.iter().find(|a| {
            let n = a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            n == format!("{setup_name}.sha256")
        })
    });

    let newer = !tag.is_empty() && compare_semver(&tag, current_version) > 0;
    Ok(UpdateState {
        state: if newer { "available" } else { "up-to-date" }.to_string(),
        current_version: current_version.to_string(),
        latest_tag: if tag.is_empty() { None } else { Some(tag) },
        published_at,
        release_url,
        notes,
        asset_name: setup_asset
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        asset_url: setup_asset
            .and_then(|a| a.get("browser_download_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        sha256_url: sha_asset
            .and_then(|a| a.get("browser_download_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        downloaded_path: None,
        progress: 0,
        error: None,
    })
}

pub fn download_and_verify(
    asset_name: &str,
    asset_url: &str,
    sha256_url: Option<&str>,
    updates_dir: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u32),
) -> Result<PathBuf, String> {
    fs::create_dir_all(updates_dir).map_err(|e| e.to_string())?;
    let target = updates_dir.join(asset_name);
    let mut file = File::create(&target).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;

    let res = http_get_stream(asset_url, "", Some(cancel), |chunk, total| {
        file.write_all(chunk).map_err(|e| e.to_string())?;
        hasher.update(chunk);
        received += chunk.len() as u64;
        if let Some(tot) = total {
            if tot > 0 {
                let pct = ((received.saturating_mul(100)) / tot).min(100) as u32;
                on_progress(pct);
            }
        }
        Ok(())
    });

    if let Err(e) = res {
        let _ = fs::remove_file(&target);
        return Err(e);
    }
    let _ = file.flush();
    drop(file);

    if let Some(surl) = sha256_url {
        if let Ok((st, body)) = http_get_text(surl, "") {
            if (200..300).contains(&st) {
                if let Some(expected) = body.split_whitespace().next() {
                    let actual = format!("{:x}", hasher.finalize());
                    if !expected.eq_ignore_ascii_case(&actual) {
                        let _ = fs::remove_file(&target);
                        return Err("SHA-256 verification failed".to_string());
                    }
                }
            }
        }
    }

    Ok(target)
}
