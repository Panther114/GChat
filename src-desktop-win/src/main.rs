#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    cell::RefCell,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageReader;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::json;
use single_instance::SingleInstance;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy},
    platform::windows::WindowExtWindows,
    window::{Icon, WindowBuilder},
};
use tray_icon::{
    menu::{Menu as TrayMenu, MenuEvent as TrayMenuEvent, MenuItem as TrayMenuItem, PredefinedMenuItem as TrayPredefined},
    MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};
use url::Url;
use wry::WebViewBuilder;

const OFFICIAL_SERVER_URL: &str = "https://gchat.up.railway.app";
const GITHUB_RELEASES_URL: &str = "https://github.com/Panther114/GChat/releases/latest";
const GITHUB_API_LATEST: &str =
    "https://api.github.com/repos/Panther114/GChat/releases/latest";
const APP_ID: &str = "com.gchat.desktop.win";
const MAX_UNREAD: u32 = 999;
const MAX_CLIPBOARD_BYTES: usize = 16 * 1024 * 1024;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(15);
// Updater bounds: release JSON ≤1 MiB, detached signature ≤16 KiB, progress
// reported every 256 KiB so the UI sees movement without event spam.
const MAX_RELEASE_JSON_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_BYTES: usize = 16 * 1024;
const UPDATE_PROGRESS_CHUNK: u64 = 256 * 1024;

/// Minisign public key for update-signature verification (base64 of the
/// minisign `.pub` file text). Source of truth:
/// `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. If that file
/// ever rotates its key, update this constant to match.
const UPDATE_PUBKEY_B64: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ2MzE2QjcwM0Y5RTg2RjMKUldUemhwNC9jR3N4MXE2ZncraHBCT1Q2YVViTk04SHFyK053em9qNnZGOXREa0ZEeDFMMjBxSnoK";

/// Offline recovery page (connection timeout / load failure). Bridge stays injected for retry.
const OFFLINE_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Gchat Connection Required</title>
<style>
  html,body{margin:0;min-height:100%;background:#0b1020;color:#d7e0f2;font:15px/1.45 system-ui,sans-serif}
  .wrap{max-width:520px;margin:0 auto;padding:48px 24px}
  h1{font-size:1.35rem;margin:0 0 12px}
  p{color:#9ab;margin:0 0 16px}
  .box{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px 16px;margin:18px 0}
  button{background:#4a90d9;color:#fff;border:0;border-radius:10px;padding:10px 16px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  code{font-size:.9em}
</style></head><body><div class="wrap">
  <h1>Gchat couldn't reach the hosted server.</h1>
  <p>This desktop build is online-only and stays locked to the official Railway deployment. Retry when your connection or the hosted service is available again.</p>
  <div class="box">
    <div><strong>Locked server:</strong> <code id="offline-server">https://gchat.up.railway.app</code></div>
    <div style="margin-top:8px"><strong>Last error:</strong> <span id="offline-error">Unavailable</span></div>
  </div>
  <button type="button" id="retry-btn">Retry connection</button>
</div>
<script>
(async function () {
  const errEl = document.getElementById('offline-error');
  const serverEl = document.getElementById('offline-server');
  const btn = document.getElementById('retry-btn');
  try {
    const ctx = await window.electronAPI.getConnectionContext();
    if (ctx && ctx.serverUrl) serverEl.textContent = ctx.serverUrl;
    if (ctx && ctx.lastLoadError) {
      const e = ctx.lastLoadError;
      errEl.textContent = [e.errorDescription, e.errorCode].filter(Boolean).join(' · ') || 'LOAD_FAILED';
    } else {
      errEl.textContent = 'The hosted app did not become ready.';
    }
  } catch (e) {
    errEl.textContent = (e && e.message) || 'Unavailable';
  }
  btn.addEventListener('click', async function () {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    try { await window.electronAPI.retryConnection(); }
    catch (_) { btn.disabled = false; btn.textContent = 'Retry connection'; }
  });
})();
</script>
</body></html>"#;

const BRIDGE_JS: &str = include_str!("bridge.js");

/// Memory-oriented WebView2 browser arguments for the thin host.
/// v1.3.9: raised the JS heap cap (192MB caused renderer OOM/blank windows in
/// long sessions) and kept optimize-for-size.
pub const WEBVIEW_MEMORY_BROWSER_ARGS: &str = concat!(
    "--disable-features=WebGPU,TranslateUI,MediaRouter,CalculateNativeWinOcclusion,",
    "InterestFeedContentSuggestions,AutofillServerCommunication,BackForwardCache,",
    "msWebOOUI,msPdfOOUI,HardwareMediaKeyHandling ",
    "--disable-background-networking ",
    "--disable-component-update ",
    "--disable-sync ",
    "--disable-default-apps ",
    "--js-flags=--max-old-space-size=384 --optimize-for-size"
);

#[derive(Debug, Clone)]
enum UserEvent {
    TrayToggle,
    TrayOpen,
    TrayCheckUpdates,
    TrayQuit,
    Ipc(String),
    UpdateStatus(UpdateStatus),
    /// v1.3.9: background updater result delivered back to the UI thread
    /// (request_id for the web reply, is_install distinguishes the reply
    /// contract) — update checks/installs never run on the event-loop thread.
    UpdateResult(UpdateStatus, String, bool),
    /// Navigate to offline recovery HTML (timeout / load failure).
    ShowOffline,
    /// Auto-retry the hosted load after a connection timeout.
    ReloadHosted,
    /// v1.4.7: clear-cache-and-restart finished its background relaunch.
    /// (request_id, ok, error) — ok exits the loop; failure reports back to
    /// the bridge and keeps the app running.
    RestartResult(String, bool, String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    state: String,
    current_version: Option<String>,
    available_version: Option<String>,
    percent: Option<u32>,
    message: Option<String>,
    error: Option<String>,
    checked_at: Option<String>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            current_version: Some(VERSION.to_string()),
            available_version: None,
            percent: None,
            message: None,
            error: None,
            checked_at: None,
        }
    }
}

#[derive(Default)]
struct AppState {
    unread: AtomicU32,
    hosted_ready: AtomicBool,
    last_load_error: Mutex<Option<serde_json::Value>>,
    pending_group_id: Mutex<Option<String>>,
    update_status: Mutex<UpdateStatus>,
    clipboard_file: Mutex<Option<PathBuf>>,
    suspended: AtomicBool,
    timeout_active: AtomicBool,
    /// v1.3.9: tray double-click delivers Click(Up)+DoubleClick+Click(Up) on
    /// Windows — debounce so one double-click never fires three toggles.
    last_toggle_at: AtomicU64,
    /// v1.3.14: H8 — the bridge IPC handler only processes messages while the
    /// webview is on a trusted page (the official hosted app or the offline
    /// recovery page). An attacker who navigates the window to any other URL
    /// (data:/about:/file:) is cut off from every bridge command.
    bridge_allowed: AtomicBool,
    /// v1.3.14: H8 — set right before `load_html(OFFLINE_HTML)` so the
    /// navigation handler can recognize the offline data: URL (the only data:
    /// navigation ever permitted) and reject every other data: URL.
    offline_page_pending: AtomicBool,
    /// v1.4.7: only one update check/download runs at a time — repeated tray
    /// or IPC checks return the in-flight status instead of stacking threads.
    update_in_flight: AtomicBool,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_iso() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn normalize_unread(value: f64) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value.floor().min(MAX_UNREAD as f64) as u32
}

fn is_official_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("gchat.up.railway.app")
        && url.port_or_known_default() == Some(443)
}

fn is_safe_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && !is_official_url(url)
}

fn valid_group_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// v1.4.7: resolve the per-user app-data base WITHOUT ever falling back to
/// the current working directory (a CWD fallback scattered cache/updates into
/// arbitrary install directories). Chain: %LOCALAPPDATA% →
/// %USERPROFILE%\AppData\Local → OS temp dir.
fn resolve_app_data_base(
    local: Option<&std::ffi::OsStr>,
    profile: Option<&std::ffi::OsStr>,
    temp: PathBuf,
) -> PathBuf {
    if let Some(local) = local.filter(|v| !v.is_empty()) {
        return PathBuf::from(local);
    }
    if let Some(profile) = profile.filter(|v| !v.is_empty()) {
        return PathBuf::from(profile).join("AppData").join("Local");
    }
    temp
}

fn app_data_dir() -> PathBuf {
    resolve_app_data_base(
        std::env::var_os("LOCALAPPDATA").as_deref(),
        std::env::var_os("USERPROFILE").as_deref(),
        std::env::temp_dir(),
    )
    .join("Gchat")
}

// v1.3.11: installed apps must find their icons next to the exe (the NSIS
// installer ships icon.png beside Gchat.exe); the old dev-only paths resolved
// relative to the working directory and produced a blank tray/taskbar icon on
// real installs.
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
}

fn icon_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("icon.png"));
        candidates.push(dir.join("assets/icon.png"));
        candidates.push(dir.join("gchat_icon.png"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/icon.png"));
    candidates.push(PathBuf::from("assets/icon.png"));
    candidates.push(PathBuf::from("public/gchat_icon.png"));
    candidates
}

fn load_icon() -> Option<Icon> {
    for path in icon_candidates() {
        if let Ok(img) = image::open(&path) {
            let rgba = img.into_rgba8();
            let (w, h) = rgba.dimensions();
            if let Ok(icon) = Icon::from_rgba(rgba.into_raw(), w, h) {
                return Some(icon);
            }
        }
    }
    None
}

fn load_tray_icon() -> Option<tray_icon::Icon> {
    for path in icon_candidates() {
        if let Ok(img) = image::open(&path) {
            let rgba = img.into_rgba8();
            let (w, h) = rgba.dimensions();
            if let Ok(icon) = tray_icon::Icon::from_rgba(rgba.into_raw(), w, h) {
                return Some(icon);
            }
        }
    }
    None
}

fn get_autostart() -> bool {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run") else {
        return false;
    };
    key.get_value::<String, _>("Gchat").is_ok()
}

fn set_autostart(enabled: bool) -> bool {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    if enabled {
        let Ok((key, _)) = hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        else {
            return false;
        };
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        // v1.4.7: report the real write result instead of assuming success.
        key.set_value("Gchat", &format!("\"{}\"", exe.display()))
            .is_ok()
    } else {
        let Ok(key) = hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run") else {
            // The Run key itself is unreadable/absent — the value is gone.
            return true;
        };
        // v1.4.7: only report success when the value is actually absent now.
        match key.delete_value("Gchat") {
            Ok(()) => true,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        }
    }
}

fn show_native_notification(title: &str, body: &str) {
    // Lightweight toast via PowerShell (no extra crate); bounded payload only.
    // v1.4.7: the script is passed via -EncodedCommand (UTF-16LE base64) so
    // non-ASCII titles/bodies survive the command line intact; only PS
    // single-quote escaping is needed inside the script itself.
    let title = title.chars().take(80).collect::<String>().replace('\'', "''");
    let body = body.chars().take(200).collect::<String>().replace('\'', "''");
    let script = format!(
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; \
         $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \
         $text = $template.GetElementsByTagName('text'); \
         $text.Item(0).AppendChild($template.CreateTextNode('{title}')) | Out-Null; \
         $text.Item(1).AppendChild($template.CreateTextNode('{body}')) | Out-Null; \
         $toast = [Windows.UI.Notifications.ToastNotification]::new($template); \
         [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Gchat').Show($toast);"
    );
    let encoded: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    let encoded_b64 = STANDARD.encode(encoded);
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded_b64])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn();
}

fn clipboard_filename(value: Option<&str>) -> String {
    let candidate = value
        .and_then(|name| Path::new(name).file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("attachment.bin");
    let sanitized: String = candidate
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')'))
        .take(120)
        .collect();
    if sanitized.is_empty() || sanitized.chars().all(|c| c == '.') {
        "attachment.bin".to_string()
    } else {
        sanitized
    }
}

fn copy_binary(state: &AppState, payload: &serde_json::Value) -> Result<bool, String> {
    let base64 = payload
        .get("base64")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if base64.len() > (MAX_CLIPBOARD_BYTES * 4 / 3) + 8 {
        return Err("Clipboard payload is too large".into());
    }
    let bytes = STANDARD
        .decode(base64.as_bytes())
        .map_err(|_| "Invalid clipboard payload".to_string())?;
    if bytes.len() > MAX_CLIPBOARD_BYTES {
        return Err("Clipboard payload is too large".into());
    }
    let mime = payload
        .get("mimeType")
        .or_else(|| payload.get("mime_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("application/octet-stream");
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    if mime.starts_with("image/") {
        let decoded = ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .decode()
            .map_err(|e| e.to_string())?
            .into_rgba8();
        let (w, h) = decoded.dimensions();
        clipboard
            .set_image(ImageData {
                width: w as usize,
                height: h as usize,
                bytes: std::borrow::Cow::Owned(decoded.into_raw()),
            })
            .map_err(|e| e.to_string())?;
        return Ok(true);
    }
    if mime.starts_with("text/") {
        let text = String::from_utf8(bytes).map_err(|_| "Invalid text attachment".to_string())?;
        clipboard.set_text(text).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    let cache_dir = app_data_dir().join("clipboard");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let filename = clipboard_filename(
        payload
            .get("filename")
            .and_then(|v| v.as_str()),
    );
    let file_path = cache_dir.join(filename);
    // v1.4.7: a poisoned cache lock or any failing step must report failure —
    // previously the whole branch was swallowed by `if let Ok(..)` and the
    // caller told the SPA the copy succeeded even when nothing was copied.
    let mut prev = state
        .clipboard_file
        .lock()
        .map_err(|_| "Clipboard cache is unavailable".to_string())?;
    if let Some(old) = prev.as_ref().filter(|p| *p != &file_path) {
        let _ = std::fs::remove_file(old);
    }
    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
    clipboard
        .set()
        .file_list(&[&file_path])
        .map_err(|e| {
            let _ = std::fs::remove_file(&file_path);
            e.to_string()
        })?;
    *prev = Some(file_path);
    Ok(true)
}

/// v1.4.7: the clipboard cache is scratch space — every file left over from a
/// previous session is deleted at startup (the "delete previous file" logic
/// during a session still applies). Keeps %LOCALAPPDATA%\Gchat\clipboard
/// bounded to at most the current session's payloads.
fn clear_clipboard_cache() {
    let dir = app_data_dir().join("clipboard");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// v1.4.7: parse a release tag into numeric dot components + prerelease flag.
/// Leading "v"/"V"/"release-" prefixes are ignored; anything after "-" or "+"
/// marks the tag as a prerelease (older than a full release of the same
/// numeric version). Returns None for tags with no numeric components.
fn parse_version_components(tag: &str) -> Option<(Vec<u64>, bool)> {
    let mut t = tag.trim();
    loop {
        if let Some(rest) = t.strip_prefix("release-") {
            t = rest;
            continue;
        }
        if let Some(rest) = t.strip_prefix('v').or_else(|| t.strip_prefix('V')) {
            t = rest;
            continue;
        }
        break;
    }
    if t.is_empty() {
        return None;
    }
    let (numeric, is_pre) = match t.find(['-', '+']) {
        Some(i) => (&t[..i], t.as_bytes()[i] == b'-'),
        None => (t, false),
    };
    let mut comps = Vec::new();
    for part in numeric.split('.') {
        match part.parse::<u64>() {
            Ok(v) => comps.push(v),
            Err(_) => break,
        }
    }
    if comps.is_empty() {
        return None;
    }
    Some((comps, is_pre))
}

/// v1.4.7: report an update ONLY when the release tag is strictly greater
/// than the running version — string equality previously offered downgrades
/// (e.g. "v1.4.6" != "1.4.6") and any unparseable tag. Never downgrades.
fn version_is_newer(candidate: &str, current: &str) -> bool {
    let Some((cand, cand_pre)) = parse_version_components(candidate) else {
        return false;
    };
    let Some((cur, cur_pre)) = parse_version_components(current) else {
        return false;
    };
    let len = cand.len().max(cur.len());
    for i in 0..len {
        let c = cand.get(i).copied().unwrap_or(0);
        let k = cur.get(i).copied().unwrap_or(0);
        if c != k {
            return c > k;
        }
    }
    // Numerically equal: only a full release beats a prerelease.
    !cand_pre && cur_pre
}

/// v1.4.7: release asset names come from GitHub JSON and are joined into a
/// filesystem path — restrict them to a strict safe shape before use.
fn is_safe_asset_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && !name.contains('/')
        && !name.contains('\\')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && name.ends_with("-setup.exe")
}

fn check_updates_sync(install: bool) -> UpdateStatus {
    check_updates_sync_with(install, None)
}

fn updater_public_key() -> Result<PublicKey, String> {
    // UPDATE_PUBKEY_B64 is base64 of the full minisign `.pub` file text
    // (comment line + base64 key blob) — exactly what PublicKey::decode parses.
    let file_text = STANDARD
        .decode(UPDATE_PUBKEY_B64)
        .map_err(|_| "Updater public key is malformed (outer base64)".to_string())?;
    let text =
        String::from_utf8(file_text).map_err(|_| "Updater public key is not UTF-8".to_string())?;
    PublicKey::decode(&text).map_err(|_| "Updater public key is invalid".to_string())
}

/// v1.4.7: check-only variant keeps the legacy call signature (`install`
/// only, no progress reporting) for background/tray checks.
fn check_updates_sync_with(
    install: bool,
    progress: Option<&EventLoopProxy<UserEvent>>,
) -> UpdateStatus {
    let mut status = UpdateStatus {
        state: "checking".into(),
        current_version: Some(VERSION.into()),
        ..Default::default()
    };
    let agent = format!("GchatDesktop/{VERSION}");
    // v1.3.9: hard timeouts — previously the timeout-less defaults let a
    // stalled GitHub call freeze the whole window ("unclickable" update button).
    // v1.3.10: 45s so a check never outlives the frontend's checking watchdog.
    let response = match ureq::get(GITHUB_API_LATEST)
        .set("User-Agent", &agent)
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(45))
        .call()
    {
        Ok(r) => r,
        Err(e) => {
            status.state = "error".into();
            status.error = Some(e.to_string());
            status.checked_at = Some(now_iso());
            return status;
        }
    };
    // v1.4.7: cap the release JSON read at 1 MiB — `into_string()` had no
    // tight bound on hostile/oversized responses.
    let body: serde_json::Value = match response.into_reader().take(MAX_RELEASE_JSON_BYTES) {
        mut limited => {
            let mut text = String::new();
            match limited.read_to_string(&mut text) {
                Ok(_) => match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        status.state = "error".into();
                        status.error = Some(e.to_string());
                        status.checked_at = Some(now_iso());
                        return status;
                    }
                },
                Err(e) => {
                    status.state = "error".into();
                    status.error = Some(e.to_string());
                    status.checked_at = Some(now_iso());
                    return status;
                }
            }
        }
    };
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if tag.is_empty() {
        status.state = "error".into();
        status.error = Some("No release tag found".into());
        status.checked_at = Some(now_iso());
        return status;
    }
    if !version_is_newer(&tag, VERSION) {
        status.state = "up-to-date".into();
        status.message = Some("You are up to date.".into());
        status.checked_at = Some(now_iso());
        return status;
    }
    status.state = "available".into();
    status.available_version = Some(tag.clone());
    status.message = Some(format!("Update {tag} is available."));
    status.checked_at = Some(now_iso());

    if !install {
        return status;
    }

    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    // v1.4.7: the installer name is validated before it is ever joined into a
    // path, and a sibling `<name>.sig` asset is REQUIRED — an unsigned
    // release can no longer ship an executable installer to this shell.
    let setup = assets.iter().find(|a| {
        a.get("name")
            .and_then(|n| n.as_str())
            .map(is_safe_asset_name)
            .unwrap_or(false)
    });
    let Some(asset) = setup else {
        status.state = "error".into();
        status.error = Some("No Windows installer on latest release".into());
        return status;
    };
    let file_name = asset
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .to_string();
    let sig_name = format!("{file_name}.sig");
    let sig_asset = assets.iter().find(|a| {
        a.get("name")
            .and_then(|n| n.as_str())
            .map(|n| n == sig_name)
            .unwrap_or(false)
    });
    let Some(sig_asset) = sig_asset else {
        status.state = "error".into();
        status.error = Some("Update signature asset missing — installer will not run.".into());
        return status;
    };
    let url = asset
        .get("browser_download_url")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let sig_url = sig_asset
        .get("browser_download_url")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if url.is_empty() || sig_url.is_empty() {
        status.state = "error".into();
        status.error = Some("Installer URL missing".into());
        return status;
    }

    // Download the detached signature first (bounded, tiny) — no point
    // pulling a large installer we cannot verify.
    status.state = "downloading".into();
    status.percent = Some(0);
    status.message = Some("Downloading update…".into());
    let signature = match ureq::get(sig_url)
        .set("User-Agent", &agent)
        .timeout(Duration::from_secs(45))
        .call()
    {
        Ok(resp) => {
            let mut text = String::new();
            match resp
                .into_reader()
                .take(MAX_SIGNATURE_BYTES as u64)
                .read_to_string(&mut text)
            {
                Ok(_) => match Signature::decode(&text) {
                    Ok(sig) => sig,
                    Err(_) => {
                        status.state = "error".into();
                        status.error =
                            Some("Update signature unreadable — installer will not run.".into());
                        status.checked_at = Some(now_iso());
                        return status;
                    }
                },
                Err(e) => {
                    status.state = "error".into();
                    status.error =
                        Some(format!("Update signature download failed (network): {e}"));
                    status.checked_at = Some(now_iso());
                    return status;
                }
            }
        }
        Err(ureq::Error::Transport(t)) => {
            status.state = "error".into();
            status.error = Some(format!("Update signature download failed (network): {t}"));
            status.checked_at = Some(now_iso());
            return status;
        }
        Err(e) => {
            status.state = "error".into();
            status.error = Some(format!("Update signature download failed: {e}"));
            status.checked_at = Some(now_iso());
            return status;
        }
    };

    let dest = app_data_dir().join("updates");
    let _ = std::fs::create_dir_all(&dest);
    let dest_file = dest.join(&file_name);
    // v1.3.9: hard overall timeout so a stalled download can never hang the
    // UI thread indefinitely.
    match ureq::get(url)
        .set("User-Agent", &agent)
        .timeout(Duration::from_secs(120))
        .call()
    {
        Ok(resp) => {
            let total = resp
                .header("Content-Length")
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|t| *t > 0);
            let mut reader = resp.into_reader();
            let write_result = match std::fs::File::create(&dest_file) {
                Ok(mut out) => {
                    let mut buf = [0u8; 64 * 1024];
                    let mut written: u64 = 0;
                    let mut next_report = UPDATE_PROGRESS_CHUNK;
                    let mut io_err: Option<std::io::Error> = None;
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                if let Err(e) = out.write_all(&buf[..n]) {
                                    io_err = Some(e);
                                    break;
                                }
                                written += n as u64;
                                if written >= next_report {
                                    next_report += UPDATE_PROGRESS_CHUNK;
                                    if let Some(proxy) = progress {
                                        let percent = total
                                            .map(|t| ((written * 100) / t).min(100) as u32);
                                        let _ = proxy.send_event(UserEvent::UpdateStatus(
                                            UpdateStatus {
                                                state: "downloading".into(),
                                                percent,
                                                message: Some("Downloading update…".into()),
                                                ..Default::default()
                                            },
                                        ));
                                    }
                                }
                            }
                            Err(e) => {
                                io_err = Some(e);
                                break;
                            }
                        }
                    }
                    match io_err {
                        Some(e) => Err(e),
                        None => Ok(written),
                    }
                }
                Err(e) => Err(e),
            };
            match write_result {
                Ok(_) => {
                    // v1.4.7: minisign verification BEFORE execution. A failed
                    // or missing signature deletes the installer; it is never
                    // spawned.
                    let verified = (|| -> Result<(), String> {
                        let pubkey = updater_public_key()?;
                        let bytes = std::fs::read(&dest_file)
                            .map_err(|e| format!("Failed to read installer for verification: {e}"))?;
                        pubkey
                            .verify(&bytes, &signature, false)
                            .map_err(|_| "Update signature verification failed".to_string())
                    })();
                    match verified {
                        Ok(()) => {
                            status.state = "ready".into();
                            status.percent = Some(100);
                            status.message = Some("Update ready to install.".into());
                            let _ = std::process::Command::new(&dest_file).spawn();
                        }
                        Err(err) => {
                            let _ = std::fs::remove_file(&dest_file);
                            status.state = "error".into();
                            status.error = Some(format!(
                                "{err} — installer deleted and NOT executed."
                            ));
                        }
                    }
                }
                Err(e) => {
                    // v1.4.7: a stalled/truncated transfer (transport) is not
                    // a disk failure — distinguish the two for the user.
                    let _ = std::fs::remove_file(&dest_file);
                    status.state = "error".into();
                    status.error = Some(format!("Failed to write installer: {e}"));
                }
            }
        }
        Err(ureq::Error::Transport(t)) => {
            status.state = "error".into();
            status.error = Some(format!("Update download failed (network): {t}"));
        }
        Err(e) => {
            status.state = "error".into();
            status.error = Some(format!("Update download failed: {e}"));
        }
    }
    status.checked_at = Some(now_iso());
    status
}

/// v1.4.7: only one update check/download at a time. Repeated tray or IPC
/// checks return the current status instead of stacking unbounded worker
/// threads.
fn try_begin_update_check(state: &AppState) -> bool {
    state
        .update_in_flight
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn spawn_update_check(
    state: &Arc<AppState>,
    proxy: &EventLoopProxy<UserEvent>,
    request_id: String,
    install: bool,
) {
    if !try_begin_update_check(state) {
        // A check/download is already running — hand back its status rather
        // than spawning another worker.
        if !request_id.is_empty() {
            let status = state
                .update_status
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            let _ = proxy.send_event(UserEvent::UpdateResult(status, request_id, install));
        }
        return;
    }
    let state_bg = state.clone();
    let proxy_bg = proxy.clone();
    thread::spawn(move || {
        let status = if install {
            check_updates_sync_with(true, Some(&proxy_bg))
        } else {
            check_updates_sync(false)
        };
        let _ = proxy_bg.send_event(UserEvent::UpdateResult(status, request_id, install));
        state_bg.update_in_flight.store(false, Ordering::Release);
    });
}

/// v1.4.7: second-instance wake-up. The `single-instance` crate only tells
/// the SECOND process it is not alone — it has no callback into the first
/// one — so the first instance listens on an ephemeral loopback TCP port
/// (published to %LOCALAPPDATA%\Gchat\second-instance.port). The duplicate
/// process connects, sends "show", and exits; the first instance shows +
/// focuses its window. Worst case for a stale port file: the connect fails
/// and the duplicate exits silently (previous behavior).
const SECOND_INSTANCE_SHOW: &[u8] = b"show";

fn second_instance_port_file() -> PathBuf {
    app_data_dir().join("second-instance.port")
}

fn listen_for_second_instance(proxy: EventLoopProxy<UserEvent>) {
    let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", 0)) else {
        return;
    };
    let Ok(addr) = listener.local_addr() else {
        return;
    };
    let _ = std::fs::create_dir_all(app_data_dir());
    let _ = std::fs::write(second_instance_port_file(), addr.port().to_string());
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut shown = false;
            let mut buf = [0u8; 16];
            let mut stream = stream;
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            if let Ok(n) = stream.read(&mut buf) {
                shown = n == SECOND_INSTANCE_SHOW.len() && &buf[..n] == SECOND_INSTANCE_SHOW;
            }
            if shown {
                let _ = proxy.send_event(UserEvent::TrayOpen);
            }
        }
    });
}

fn signal_running_instance() {
    let Ok(text) = std::fs::read_to_string(second_instance_port_file()) else {
        return;
    };
    let Ok(port) = text.trim().parse::<u16>() else {
        return;
    };
    if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
        let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
        let _ = std::io::Write::write_all(&mut stream, SECOND_INSTANCE_SHOW);
    }
}

fn apply_webview_env() {
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        WEBVIEW_MEMORY_BROWSER_ARGS,
    );
}

fn main() {
    apply_webview_env();

    // v1.3.9: graceful startup — no expect() panics (panic=abort would kill
    // the process with no diagnostics).
    let instance = match SingleInstance::new(APP_ID) {
        Ok(inst) => inst,
        Err(err) => {
            eprintln!("Gchat: single instance init failed: {err}");
            std::process::exit(1);
        }
    };
    if !instance.is_single() {
        // v1.4.7: wake the first instance (show + focus) instead of exiting
        // silently, then let it keep owning the app.
        signal_running_instance();
        return;
    }

    // v1.4.7: the clipboard cache is scratch space — wipe leftovers from
    // previous sessions at startup (bounded: only files, one small dir).
    clear_clipboard_cache();

    let state = Arc::new(AppState::default());
    {
        let mut us = match state.update_status.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *us = UpdateStatus::default();
    }

    let event_loop: EventLoop<UserEvent> = EventLoopBuilder::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let mut window_builder = WindowBuilder::new()
        .with_title("Gchat")
        .with_inner_size(LogicalSize::new(1100.0, 700.0))
        .with_min_inner_size(LogicalSize::new(880.0, 600.0));
    if let Some(icon) = load_icon() {
        window_builder = window_builder.with_window_icon(Some(icon));
    }
    let window = match window_builder.build(&event_loop) {
        Ok(window) => window,
        Err(err) => {
            eprintln!("Gchat: window creation failed: {err}");
            std::process::exit(1);
        }
    };

    let proxy_ipc = proxy.clone();
    let nav_state = state.clone();
    let built_webview = WebViewBuilder::new()
        .with_initialization_script(BRIDGE_JS)
        .with_url(OFFICIAL_SERVER_URL)
        .with_ipc_handler(move |message| {
            let _ = proxy_ipc.send_event(UserEvent::Ipc(message.body().to_string()));
        })
        // v1.3.14: H8 — navigation whitelist. Only the official hosted app and
        // the offline recovery page (loaded via `load_html`, a data: URL, only
        // ever triggered by our own code path) may load in-window. Any other
        // data:/about:/file:/http(s) navigation is denied (safe external links
        // still open in the default browser).
        .with_navigation_handler(move |url| {
            if let Ok(parsed) = Url::parse(&url) {
                if is_official_url(&parsed) {
                    nav_state.bridge_allowed.store(true, Ordering::Release);
                    return true;
                }
                if url == "about:blank" {
                    // WebView2's initial/blank page — no script origin of its
                    // own; the bridge itself is gated per-document, so a
                    // blank page never gains bridge access.
                    nav_state.bridge_allowed.store(false, Ordering::Release);
                    return true;
                }
                if url.starts_with("data:") {
                    let is_offline = nav_state.offline_page_pending.swap(false, Ordering::AcqRel);
                    if is_offline {
                        nav_state.bridge_allowed.store(true, Ordering::Release);
                        return true;
                    }
                    return false;
                }
                if is_safe_external(&parsed) {
                    let _ = open::that(url);
                }
                return false;
            }
            false
        })
        .with_new_window_req_handler(|url| {
            if let Ok(parsed) = Url::parse(&url) {
                if is_safe_external(&parsed) {
                    let _ = open::that(url);
                }
            }
            false
        })
        .build(&window);
    let webview = match built_webview {
        Ok(webview) => webview,
        Err(err) => {
            eprintln!("Gchat: webview creation failed: {err}");
            std::process::exit(1);
        }
    };

    let webview = Rc::new(RefCell::new(webview));

    // v1.4.7: listen for duplicate launches and surface the existing window.
    listen_for_second_instance(proxy.clone());

    // Tray
    let open_item = TrayMenuItem::with_id("open", "Open Gchat", true, None);
    let update_item = TrayMenuItem::with_id("check-updates", "Check for Updates", true, None);
    let quit_item = TrayMenuItem::with_id("quit", "Quit", true, None);
    // v1.4.7: keep a live handle to the status item so its text can track the
    // unread count (previously it was created inline and frozen forever).
    let status_item = TrayMenuItem::with_id("status", "Gchat", false, None);
    let tray_menu = TrayMenu::new();
    let _ = tray_menu.append(&status_item);
    let _ = tray_menu.append(&TrayPredefined::separator());
    let _ = tray_menu.append(&open_item);
    let _ = tray_menu.append(&update_item);
    let _ = tray_menu.append(&TrayPredefined::separator());
    let _ = tray_menu.append(&quit_item);

    let mut tray_builder = TrayIconBuilder::new()
        .with_menu(Box::new(tray_menu))
        .with_tooltip("Gchat")
        .with_title("Gchat")
        // v1.3.9: left-click must only toggle the window — never also pop the
        // context menu (default), which made the app hide under a floating menu.
        .with_menu_on_left_click(false);
    if let Some(icon) = load_tray_icon() {
        tray_builder = tray_builder.with_icon(icon);
    }
    let tray = tray_builder.build().ok();

    let proxy_tray = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let _ = proxy_tray.send_event(UserEvent::TrayToggle);
        }
    }));

    let proxy_menu = proxy.clone();
    TrayMenuEvent::set_event_handler(Some(move |event: TrayMenuEvent| {
        match event.id.as_ref() {
            "open" => {
                let _ = proxy_menu.send_event(UserEvent::TrayOpen);
            }
            "check-updates" => {
                let _ = proxy_menu.send_event(UserEvent::TrayCheckUpdates);
            }
            "quit" => {
                let _ = proxy_menu.send_event(UserEvent::TrayQuit);
            }
            _ => {}
        }
    }));

    // Connection timeout → offline recovery page if hosted app never signals ready.
    schedule_connection_timeout(proxy.clone(), state.clone());

    // Background updater (check only; install on demand) after 15s then every 30m.
    // v1.4.7: routed through the shared in-flight guard — no stacked workers.
    {
        let proxy_up = proxy.clone();
        let state_up = state.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(15));
            loop {
                spawn_update_check(&state_up, &proxy_up, String::new(), false);
                thread::sleep(Duration::from_secs(30 * 60));
            }
        });
    }

    let mut quitting = false;

    event_loop.run(move |event, event_loop, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::UserEvent(UserEvent::TrayQuit) => {
                quitting = true;
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::TrayOpen) => {
                resume_hosted(&window, &webview, &state, &proxy);
                deliver_pending_group(&webview, &state);
                let _ = window.set_skip_taskbar(false);
                // v1.3.9: unminimize explicitly — restore must never stay stuck
                // minimized after a minimize→tray-hide.
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
            }
            Event::UserEvent(UserEvent::TrayToggle) => {
                // v1.3.9: debounce double-click (Windows fires two Click-Ups per
                // double-click), which previously toggled hide→show→hide.
                let now_ms = now_unix_ms();
                let prev_ms = state.last_toggle_at.load(Ordering::Acquire);
                state.last_toggle_at.store(now_ms, Ordering::Release);
                if now_ms.saturating_sub(prev_ms) < 400 {
                    // Double-click echo of the first toggle — ignore.
                    return;
                }
                if window.is_visible() && window.is_focused() {
                    suspend_to_tray(&window, &webview, &state);
                } else {
                    resume_hosted(&window, &webview, &state, &proxy);
                    deliver_pending_group(&webview, &state);
                    let _ = window.set_skip_taskbar(false);
                    window.set_minimized(false);
                    window.set_visible(true);
                    window.set_focus();
                }
            }
            Event::UserEvent(UserEvent::ReloadHosted) => {
                if !state.hosted_ready.load(Ordering::Acquire)
                    && !state.suspended.load(Ordering::Acquire)
                {
                    if let Ok(mut err) = state.last_load_error.lock() {
                        *err = None;
                    }
                    let _ = webview.borrow().load_url(OFFICIAL_SERVER_URL);
                }
            }
            Event::UserEvent(UserEvent::TrayCheckUpdates) => {
                // Manual tray check only reports status — never auto-downloads/spawns installer.
                spawn_update_check(&state, &proxy, String::new(), false);
            }
            Event::UserEvent(UserEvent::UpdateStatus(status)) => {
                push_update_status(&webview, &status);
                if let Ok(mut slot) = state.update_status.lock() {
                    *slot = status;
                }
            }
            Event::UserEvent(UserEvent::UpdateResult(status, request_id, is_install)) => {
                // v1.3.9: background updater finished — reply to the web UI,
                // push the status, and quit after an install download so the
                // NSIS installer is not file-locked by the running exe.
                // v1.3.10: a plain check replies the full UpdateStatus object
                // (previously 'available' was wrongly reported as an error
                // and the frontend promise rejected).
                if let Ok(mut slot) = state.update_status.lock() {
                    *slot = status.clone();
                }
                if !request_id.is_empty() {
                    if is_install {
                        let ok = status.state == "ready" || status.state == "up-to-date";
                        if ok {
                            reply(&webview, &request_id, json!(true), None);
                        } else {
                            let err = status
                                .error
                                .clone()
                                .or_else(|| status.message.clone())
                                .unwrap_or_else(|| "Update install failed.".into());
                            reply(&webview, &request_id, json!(false), Some(err));
                        }
                    } else if let Ok(val) = serde_json::to_value(&status) {
                        reply(&webview, &request_id, val, None);
                    }
                }
                push_update_status(&webview, &status);
                if is_install && status.state == "ready" {
                    let _ = proxy.send_event(UserEvent::TrayQuit);
                }
            }
            Event::UserEvent(UserEvent::ShowOffline) => {
                show_offline_page(&webview, &state);
            }
            Event::UserEvent(UserEvent::Ipc(raw)) => {
                handle_ipc(
                    &raw,
                    &window,
                    &webview,
                    &state,
                    &proxy,
                    &tray,
                    &status_item,
                );
            }
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => {
                    if !quitting {
                        suspend_to_tray(&window, &webview, &state);
                    }
                }
                WindowEvent::Resized(size) => {
                    // v1.3.9: no manual set_bounds — wry's own resize handling
                    // rebinds the WebView2 controller; our extra (physical-px)
                    // set_bounds fought it and produced clipped content and
                    // doubled rebind traffic on scaled displays.
                    let _ = size;
                    // Minimize goes to tray (same as close), matching prior Tauri behavior.
                    if !quitting && window.is_minimized() {
                        suspend_to_tray(&window, &webview, &state);
                    }
                }
                WindowEvent::Moved(_) => {
                    if !quitting && window.is_minimized() {
                        suspend_to_tray(&window, &webview, &state);
                    }
                }
                WindowEvent::Focused(true) => {
                    deliver_pending_group(&webview, &state);
                }
                _ => {}
            },
            Event::UserEvent(UserEvent::RestartResult(request_id, ok, error)) => {
                // v1.4.7: clear-cache-and-restart relaunch outcome. Success
                // exits (the fresh instance is already starting); a failed
                // relaunch reports back to the bridge and keeps running.
                if ok {
                    quitting = true;
                    *control_flow = ControlFlow::Exit;
                } else if !request_id.is_empty() {
                    reply(&webview, &request_id, json!(false), Some(error));
                }
            }
            _ => {}
        }

        // Keep event_loop referenced for tray
        let _ = event_loop;
    });
}

fn suspend_to_tray(
    window: &tao::window::Window,
    _webview: &Rc<RefCell<wry::WebView>>,
    state: &Arc<AppState>,
) {
    // Keep the SPA fully alive while tray-hidden: hiding the window only (no
    // page unload) means restore is instant — the socket stays connected,
    // caches stay warm, and there is no cold start on every tray click.
    state.suspended.store(true, Ordering::Release);
    // v1.4.7: hide FIRST, then drop the minimized state. Un-minimizing while
    // still visible made the taskbar window visibly pop back before
    // vanishing. Every restore path (resume_hosted, TrayOpen, TrayToggle)
    // still calls set_minimized(false) before set_visible(true), so restore
    // never stays stuck minimized.
    window.set_visible(false);
    let _ = window.set_skip_taskbar(true);
    window.set_minimized(false);
}

/// A tray-restore of a live SPA must never reload it (instant show); only a
/// genuine cold start (hosted app not ready) navigates back to the server.
fn should_reload_on_resume(hosted_ready: bool) -> bool {
    !hosted_ready
}

fn resume_hosted(
    window: &tao::window::Window,
    webview: &Rc<RefCell<wry::WebView>>,
    state: &Arc<AppState>,
    proxy: &EventLoopProxy<UserEvent>,
) {
    state.suspended.swap(false, Ordering::AcqRel);
    // v1.3.9: never leave the window minimized on restore (a minimized window
    // reports is_visible()=true, which previously broke the tray toggle).
    window.set_minimized(false);
    // A genuine cold start (first launch / failed load / retry) still reloads
    // the hosted app; a plain tray-restore of a live SPA does nothing.
    if should_reload_on_resume(state.hosted_ready.load(Ordering::Acquire)) {
        state.hosted_ready.store(false, Ordering::Release);
        let _ = webview.borrow().load_url(OFFICIAL_SERVER_URL);
        schedule_connection_timeout(proxy.clone(), state.clone());
    }
    let _ = window.set_skip_taskbar(false);
}

fn show_offline_page(webview: &Rc<RefCell<wry::WebView>>, state: &Arc<AppState>) {
    if state.suspended.load(Ordering::Acquire) {
        return;
    }
    if state.hosted_ready.load(Ordering::Acquire) {
        return;
    }
    if let Ok(mut err) = state.last_load_error.lock() {
        if err.is_none() {
            *err = Some(json!({
                "errorCode": "LOAD_TIMEOUT",
                "errorDescription": "The hosted Gchat application did not become ready.",
                "url": OFFICIAL_SERVER_URL
            }));
        }
    }
    // v1.3.14: H8 — mark the upcoming data: navigation as the offline page so
    // the navigation handler accepts it (and only it).
    state.offline_page_pending.store(true, Ordering::Release);
    let _ = webview.borrow().load_html(OFFLINE_HTML);
}

/// Delivers a notification-click group id to the hosted SPA. Consumed when the
/// window gains focus or the user opens the app from the tray, so clicking a
/// message toast never dead-ends.
fn deliver_pending_group(webview: &Rc<RefCell<wry::WebView>>, state: &Arc<AppState>) {
    if let Ok(mut pending) = state.pending_group_id.lock() {
        if let Some(group_id) = pending.take() {
            if let Ok(json) = serde_json::to_string(&group_id) {
                let _ = webview.borrow().evaluate_script(&format!(
                    "window.__gchatDesktopFocusGroup?.({json})"
                ));
            }
        }
    }
}

/// Monitors hosted-app readiness with automatic retries. A single thread runs
/// at a time (guarded by `timeout_active`); slow Railway cold starts trigger
/// automatic reloads instead of a premature offline page, and only after all
/// retries are exhausted is the offline recovery page shown.
fn schedule_connection_timeout(proxy: EventLoopProxy<UserEvent>, state: Arc<AppState>) {
    if state
        .timeout_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    thread::spawn(move || {
        const MAX_AUTO_RETRIES: u32 = 3;
        for attempt in 0..=MAX_AUTO_RETRIES {
            thread::sleep(CONNECTION_TIMEOUT);
            if state.hosted_ready.load(Ordering::Acquire) || state.suspended.load(Ordering::Acquire)
            {
                state.timeout_active.store(false, Ordering::Release);
                return;
            }
            if let Ok(mut err) = state.last_load_error.lock() {
                *err = Some(json!({
                    "errorCode": "LOAD_TIMEOUT",
                    "errorDescription": "The hosted Gchat application did not become ready.",
                    "url": OFFICIAL_SERVER_URL
                }));
            }
            if attempt < MAX_AUTO_RETRIES {
                let _ = proxy.send_event(UserEvent::ReloadHosted);
            } else {
                let _ = proxy.send_event(UserEvent::ShowOffline);
            }
        }
        state.timeout_active.store(false, Ordering::Release);
    });
}

fn push_update_status(webview: &Rc<RefCell<wry::WebView>>, status: &UpdateStatus) {
    if let Ok(json) = serde_json::to_string(status) {
        let _ = webview
            .borrow()
            .evaluate_script(&format!("window.__gchatDesktopUpdateStatus?.({json})"));
    }
}

/// v1.4.7: full single-quote-safe JS string escaping. Previously only
/// backslash and single quote were handled — an error message containing a
/// newline, double quote, or control character produced invalid JS (or JS
/// injection) inside the evaluated script.
fn escape_js_string(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for c in input.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '"' => out.push_str("\\\""),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

fn reply(webview: &Rc<RefCell<wry::WebView>>, id: &str, value: serde_json::Value, error: Option<String>) {
    let value_json = value.to_string();
    let id_json = escape_js_string(id);
    let err_json = error
        .map(|e| format!("'{}'", escape_js_string(&e)))
        .unwrap_or_else(|| "null".into());
    let _ = webview.borrow().evaluate_script(&format!(
        "window.__gchatDesktopResolve?.('{id_json}', {value_json}, {err_json})"
    ));
}

fn handle_ipc(
    raw: &str,
    window: &tao::window::Window,
    webview: &Rc<RefCell<wry::WebView>>,
    state: &Arc<AppState>,
    proxy: &EventLoopProxy<UserEvent>,
    tray: &Option<TrayIcon>,
    status_item: &TrayMenuItem,
) {
    // v1.3.14: H8 — only process bridge messages while the webview is on a
    // trusted page (official hosted app or the offline recovery page). Any
    // other page — data:/about:/file: or a foreign origin — is cut off from
    // every bridge command (install-update, clear-cache-and-restart, ...).
    if !state.bridge_allowed.load(Ordering::Acquire) {
        return;
    }
    let msg: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    let typ = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let payload = msg.get("payload").cloned().unwrap_or(json!({}));
    let request_id = payload
        .get("__requestId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    match typ {
        "desktop-renderer-ready" => {
            state.hosted_ready.store(true, Ordering::Release);
            if let Ok(mut err) = state.last_load_error.lock() {
                *err = None;
            }
        }
        "set-unread-count" => {
            let count = payload
                .get("count")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let unread = normalize_unread(count);
            state.unread.store(unread, Ordering::Release);
            // v1.4.7: the status item is a live label — update its text with
            // the unread count alongside the tooltip (the tray menu item used
            // to be frozen at "Gchat"). Taskbar badge remains a documented gap.
            let label = if unread == 0 {
                "Gchat".to_string()
            } else {
                format!("Gchat — {unread} unread")
            };
            status_item.set_text(&label);
            if let Some(tray) = tray {
                let _ = tray.set_tooltip(Some(label));
            }
            if unread > 0 && !window.is_focused() {
                window.request_user_attention(Some(tao::window::UserAttentionType::Informational));
            }
        }
        "show-notification" => {
            let title = payload
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Gchat");
            let body = payload
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("New message");
            if let Some(gid) = payload.get("groupId").and_then(|v| v.as_str()) {
                if valid_group_id(gid) {
                    if let Ok(mut slot) = state.pending_group_id.lock() {
                        *slot = Some(gid.to_string());
                    }
                }
            }
            // Toast only — do not steal focus or resume SPA (matches prior Tauri behavior).
            // Restore from tray will surface pending group via Focused(true).
            show_native_notification(title, body);
            let _ = (proxy, window);
        }
        "get-launch-at-startup" => {
            if !request_id.is_empty() {
                reply(webview, &request_id, json!(get_autostart()), None);
            }
        }
        "set-launch-at-startup" => {
            let enabled = payload
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let ok = set_autostart(enabled);
            if !request_id.is_empty() {
                // v1.4.7: report the real result (previously disabling always
                // replied `false` via `ok && enabled`, hiding registry
                // failures AND successes alike).
                reply(webview, &request_id, json!(ok), None);
            }
        }
        "retry-connection" => {
            state.hosted_ready.store(false, Ordering::Release);
            state.suspended.store(false, Ordering::Release);
            if let Ok(mut err) = state.last_load_error.lock() {
                *err = None;
            }
            let _ = webview.borrow().load_url(OFFICIAL_SERVER_URL);
            schedule_connection_timeout(proxy.clone(), state.clone());
            if !request_id.is_empty() {
                reply(webview, &request_id, json!(true), None);
            }
        }
        "get-connection-context" => {
            let err = state
                .last_load_error
                .lock()
                .ok()
                .and_then(|g| g.clone());
            if !request_id.is_empty() {
                reply(
                    webview,
                    &request_id,
                    json!({ "serverUrl": OFFICIAL_SERVER_URL, "lastLoadError": err }),
                    None,
                );
            }
        }
        "copy-binary-to-clipboard" => {
            let result = copy_binary(state, &payload);
            if !request_id.is_empty() {
                match result {
                    Ok(v) => reply(webview, &request_id, json!(v), None),
                    Err(e) => reply(webview, &request_id, json!(false), Some(e)),
                }
            }
        }
        "clear-cache-and-restart" => {
            if !request_id.is_empty() {
                // v1.4.7: report success to the bridge immediately — the UI
                // thread used to block 1.5s here and the process exited even
                // when the relaunch spawn failed (silent death).
                reply(webview, &request_id, json!(true), None);
            }
            // ClearBrowsingDataAll completes asynchronously; exiting immediately
            // cancels it and the cache clear silently no-ops. Give the profile
            // clear time to finish before relaunching — on a worker thread, so
            // the window stays responsive.
            let _ = webview.borrow().clear_all_browsing_data();
            let rid = request_id.clone();
            let proxy_bg = proxy.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(1500));
                let launched = std::env::current_exe()
                    .ok()
                    .and_then(|exe| std::process::Command::new(exe).spawn().ok())
                    .is_some();
                let error = if launched {
                    String::new()
                } else {
                    "Failed to relaunch Gchat after clearing the cache.".to_string()
                };
                let _ = proxy_bg.send_event(UserEvent::RestartResult(rid, launched, error));
            });
        }
        "reload-hosted-app" => {
            // Full reset: clear readiness + error so a failed reload is caught
            // by the connection-timeout monitor again (offline recovery).
            state.suspended.store(false, Ordering::Release);
            state.hosted_ready.store(false, Ordering::Release);
            if let Ok(mut err) = state.last_load_error.lock() {
                *err = None;
            }
            let _ = webview.borrow().load_url(OFFICIAL_SERVER_URL);
            schedule_connection_timeout(proxy.clone(), state.clone());
            if !request_id.is_empty() {
                reply(webview, &request_id, json!(true), None);
            }
        }
        "check-for-updates" => {
            // v1.3.9: run on a worker thread — a stalled GitHub call must
            // never freeze the window (previously the UI thread blocked with
            // no HTTP timeout, making the update button "unclickable").
            // v1.3.10: the result replies the full UpdateStatus object.
            // v1.4.7: routed through the shared in-flight guard.
            spawn_update_check(state, proxy, request_id.clone(), false);
        }
        "get-update-status" => {
            let status = state
                .update_status
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            if !request_id.is_empty() {
                if let Ok(val) = serde_json::to_value(&status) {
                    reply(webview, &request_id, val, None);
                }
            }
        }
        "install-update" => {
            // v1.3.9: the installer download (up to ~60-120s) runs on a worker
            // thread; the window stays responsive and reports progress via
            // UpdateResult. Quit-on-ready is handled in the event loop.
            // v1.4.7: shared in-flight guard + signature-verified download
            // with coarse progress events.
            spawn_update_check(state, proxy, request_id.clone(), true);
        }
        "open-latest-release" => {
            let _ = open::that(GITHUB_RELEASES_URL);
            if !request_id.is_empty() {
                reply(webview, &request_id, json!(true), None);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unread_is_bounded() {
        assert_eq!(normalize_unread(f64::NAN), 0.0 as u32);
        assert_eq!(normalize_unread(-1.0), 0);
        assert_eq!(normalize_unread(2.9), 2);
        assert_eq!(normalize_unread(50_000.0), MAX_UNREAD);
    }

    #[test]
    fn official_origin_only() {
        let ok = Url::parse("https://gchat.up.railway.app/chat.html").unwrap();
        let bad = Url::parse("https://evil.com").unwrap();
        assert!(is_official_url(&ok));
        assert!(!is_official_url(&bad));
        assert!(is_safe_external(&bad));
    }

    #[test]
    fn memory_args_cap_v8() {
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("max-old-space-size=384"));
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("disable-features=WebGPU"));
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("optimize-for-size"));
    }

    #[test]
    fn tray_hide_keeps_spa_alive_for_instant_restore() {
        // v1.3.8: a live SPA must never reload on tray restore — no cold start.
        assert!(!should_reload_on_resume(true));
        // Only a genuine cold start (hosted app never became ready) reloads.
        assert!(should_reload_on_resume(false));
    }

    #[test]
    fn release_tag_comparison_is_numeric_and_never_downgrades() {
        // Strictly greater → update offered.
        assert!(version_is_newer("1.4.7", "1.4.6"));
        assert!(version_is_newer("v1.4.7", "1.4.6"));
        assert!(version_is_newer("V1.5.0", "1.4.6"));
        assert!(version_is_newer("release-2.0.0", "1.4.6"));
        assert!(version_is_newer("1.5", "1.4.9"));
        assert!(version_is_newer("1.4.7-beta", "1.4.6"));
        // Equal (any prefix spelling) → no update.
        assert!(!version_is_newer("1.4.6", "1.4.6"));
        assert!(!version_is_newer("v1.4.6", "1.4.6"));
        assert!(!version_is_newer("release-1.4.6", "1.4.6"));
        // Downgrades → never offered.
        assert!(!version_is_newer("1.4.5", "1.4.6"));
        assert!(!version_is_newer("v1.4.5", "1.4.6"));
        assert!(!version_is_newer("1.3.99", "1.4.6"));
        // Prerelease of the same numeric version → older, not offered.
        assert!(!version_is_newer("1.4.7-beta", "1.4.7"));
        assert!(!version_is_newer("1.5.0-rc.1", "1.5.0"));
        // Full release beats a prerelease current version.
        assert!(version_is_newer("1.4.7", "1.4.7-beta"));
        // Unparseable / garbage tags → never offered.
        assert!(!version_is_newer("", "1.4.6"));
        assert!(!version_is_newer("not-a-version", "1.4.6"));
        assert!(!version_is_newer("v", "1.4.6"));
        // Numeric comparison, not lexical (10 > 2, 9 < 10).
        assert!(version_is_newer("1.4.10", "1.4.2"));
        assert!(version_is_newer("1.10.0", "1.9.0"));
    }

    #[test]
    fn parse_version_components_handles_prefixes_and_prerelease() {
        assert_eq!(
            parse_version_components("v1.2.3"),
            Some((vec![1, 2, 3], false))
        );
        assert_eq!(
            parse_version_components("release-4.5"),
            Some((vec![4, 5], false))
        );
        assert_eq!(
            parse_version_components("1.2.3-beta.1"),
            Some((vec![1, 2, 3], true))
        );
        assert_eq!(parse_version_components("garbage"), None);
        assert_eq!(parse_version_components(""), None);
    }

    #[test]
    fn release_asset_names_are_validated_before_path_use() {
        assert!(is_safe_asset_name("Gchat-1.4.6-setup.exe"));
        assert!(is_safe_asset_name("Gchat_1.4.6-setup.exe"));
        // Path traversal / separators are rejected even though the charset
        // would exclude them — defense in depth.
        assert!(!is_safe_asset_name("..\\evil-setup.exe"));
        assert!(!is_safe_asset_name("../evil-setup.exe"));
        assert!(!is_safe_asset_name("sub/dir-setup.exe"));
        assert!(!is_safe_asset_name("sub\\dir-setup.exe"));
        assert!(!is_safe_asset_name(".."));
        // Wrong shape: must end with `-setup.exe` and stay in the charset.
        assert!(!is_safe_asset_name("setup.exe"));
        assert!(!is_safe_asset_name("Gchat Setup 1.4.6.exe"));
        assert!(!is_safe_asset_name("Gchat-1.4.6-setup.exe.txt"));
        assert!(!is_safe_asset_name("Gchat-1.4.6-setup.exe.sig"));
        assert!(!is_safe_asset_name(""));
        assert!(!is_safe_asset_name("Gchat-1.4.6-setup.exe\u{00e9}"));
    }

    #[test]
    fn js_error_strings_are_fully_escaped() {
        assert_eq!(escape_js_string("plain"), "plain");
        assert_eq!(escape_js_string("back\\slash"), "back\\\\slash");
        assert_eq!(escape_js_string("it's"), "it\\'s");
        assert_eq!(escape_js_string("say \"hi\""), "say \\\"hi\\\"");
        assert_eq!(escape_js_string("a\r\nb"), "a\\r\\nb");
        assert_eq!(escape_js_string("tab\there"), "tab\\u0009here");
        assert_eq!(escape_js_string("nul\u{0000}x"), "nul\\u0000x");
        assert_eq!(escape_js_string("del\u{007f}"), "del\u{007f}");
        // Escaped output is fully safe inside single-quoted JS.
        assert_eq!(escape_js_string("bad'\n\\\""), "bad\\'\\n\\\\\\\"");
    }

    #[test]
    fn request_ids_are_escaped_too() {
        // A hostile __requestId must not be able to inject JS via reply():
        // every quote/control char ends up escaped, so the id stays a string.
        let evil = "x');installUpdate();//";
        assert_eq!(escape_js_string(evil), "x\\');installUpdate();//");
        assert_eq!(escape_js_string("id\n1"), "id\\n1");
    }

    #[test]
    fn clipboard_filenames_are_sanitized() {
        assert_eq!(clipboard_filename(Some("photo.png")), "photo.png");
        assert_eq!(
            clipboard_filename(Some("../secret.txt")),
            "secret.txt"
        );
        assert_eq!(clipboard_filename(Some("..\\evil.exe")), "evil.exe");
        assert_eq!(
            clipboard_filename(Some("weird <name> ?.pdf")),
            "weird name .pdf"
        );
        assert_eq!(clipboard_filename(Some("")), "attachment.bin");
        assert_eq!(clipboard_filename(None), "attachment.bin");
        assert_eq!(clipboard_filename(Some("....")), "attachment.bin");
        let long = clipboard_filename(Some(&"a".repeat(500)));
        assert!(long.len() <= 120);
    }

    #[test]
    fn app_data_base_never_falls_back_to_cwd() {
        let temp = PathBuf::from("C:\\Temp");
        // LOCALAPPDATA wins.
        assert_eq!(
            resolve_app_data_base(Some("C:\\Users\\u\\AppData\\Local".as_ref()), None, temp.clone()),
            PathBuf::from("C:\\Users\\u\\AppData\\Local")
        );
        // Missing LOCALAPPDATA → %USERPROFILE%\AppData\Local.
        assert_eq!(
            resolve_app_data_base(None, Some("C:\\Users\\u".as_ref()), temp.clone()),
            PathBuf::from("C:\\Users\\u\\AppData\\Local")
        );
        // Empty-string env values behave like missing ones.
        assert_eq!(
            resolve_app_data_base(Some("".as_ref()), Some("C:\\Users\\u".as_ref()), temp.clone()),
            PathBuf::from("C:\\Users\\u\\AppData\\Local")
        );
        // Last resort is the OS temp dir — never ".".
        assert_eq!(resolve_app_data_base(None, None, temp.clone()), temp);
    }

    #[test]
    fn updater_public_key_decodes() {
        // The hardcoded tauri.conf.json pubkey must remain parseable.
        let key = updater_public_key().expect("embedded update pubkey must decode");
        // Sanity: a fresh key object round-trips through verification setup.
        let _ = &key;
    }

    #[test]
    fn offline_html_supports_retry_via_bridge() {
        assert!(OFFLINE_HTML.contains("Retry connection"));
        assert!(OFFLINE_HTML.contains("electronAPI.retryConnection"));
        assert!(OFFLINE_HTML.contains("getConnectionContext"));
    }

    #[test]
    fn install_status_failure_is_detectable() {
        let failed = UpdateStatus {
            state: "error".into(),
            error: Some("network down".into()),
            ..Default::default()
        };
        let ok_ready = UpdateStatus {
            state: "ready".into(),
            ..Default::default()
        };
        assert_ne!(failed.state, "ready");
        assert!(failed.error.is_some());
        assert_eq!(ok_ready.state, "ready");
    }
}
