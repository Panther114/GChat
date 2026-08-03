#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageReader;
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
use wry::{Rect, WebViewBuilder};

const OFFICIAL_SERVER_URL: &str = "https://gchat.up.railway.app";
const GITHUB_RELEASES_URL: &str = "https://github.com/Panther114/GChat/releases/latest";
const GITHUB_API_LATEST: &str =
    "https://api.github.com/repos/Panther114/GChat/releases/latest";
const APP_ID: &str = "com.gchat.desktop.win";
const MAX_UNREAD: u32 = 999;
const MAX_CLIPBOARD_BYTES: usize = 16 * 1024 * 1024;
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Suspended placeholder while tray-hidden — frees SPA heap in WebView2.
const SUSPEND_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8">
<title>Gchat</title>
<style>html,body{margin:0;background:#0b1020;color:#9ab;font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100%}</style>
</head><body>Gchat is running in the tray…</body></html>"#;

const BRIDGE_JS: &str = include_str!("bridge.js");

/// Memory-oriented WebView2 browser arguments for the thin host.
pub const WEBVIEW_MEMORY_BROWSER_ARGS: &str = concat!(
    "--disable-features=WebGPU,TranslateUI,MediaRouter,CalculateNativeWinOcclusion,",
    "InterestFeedContentSuggestions,AutofillServerCommunication,BackForwardCache,",
    "msWebOOUI,msPdfOOUI,HardwareMediaKeyHandling ",
    "--disable-background-networking ",
    "--disable-component-update ",
    "--disable-sync ",
    "--disable-default-apps ",
    "--js-flags=--max-old-space-size=192 --optimize-for-size"
);

#[derive(Debug, Clone)]
enum UserEvent {
    TrayToggle,
    TrayOpen,
    TrayCheckUpdates,
    TrayQuit,
    Ipc(String),
    UpdateStatus(UpdateStatus),
    ShowWindow,
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

fn app_data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Gchat")
}

fn load_icon() -> Option<Icon> {
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/icon.png"),
        PathBuf::from("assets/icon.png"),
        PathBuf::from("public/gchat_icon.png"),
    ];
    for path in candidates {
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
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/icon.png"),
        PathBuf::from("assets/icon.png"),
        PathBuf::from("public/gchat_icon.png"),
    ];
    for path in candidates {
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
    let Ok(key) = hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run") else {
        return false;
    };
    if enabled {
        if let Ok(exe) = std::env::current_exe() {
            let _ = key.0.set_value("Gchat", &format!("\"{}\"", exe.display()));
            return true;
        }
        return false;
    }
    let _ = key.0.delete_value("Gchat");
    true
}

fn show_native_notification(title: &str, body: &str) {
    // Lightweight toast via PowerShell (no extra crate); bounded payload only.
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
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
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
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
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
    if let Ok(mut prev) = state.clipboard_file.lock() {
        if let Some(old) = prev.as_ref().filter(|p| *p != &file_path) {
            let _ = std::fs::remove_file(old);
        }
        std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
        clipboard
            .set()
            .file_list(&[&file_path])
            .map_err(|e| e.to_string())?;
        *prev = Some(file_path);
    }
    Ok(true)
}

fn check_updates_sync(install: bool) -> UpdateStatus {
    let mut status = UpdateStatus {
        state: "checking".into(),
        current_version: Some(VERSION.into()),
        ..Default::default()
    };
    let agent = format!("GchatDesktop/{VERSION}");
    let response = match ureq::get(GITHUB_API_LATEST)
        .set("User-Agent", &agent)
        .set("Accept", "application/vnd.github+json")
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
    let body: serde_json::Value = match response.into_string() {
        Ok(text) => match serde_json::from_str(&text) {
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
    };
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    if tag.is_empty() {
        status.state = "error".into();
        status.error = Some("No release tag found".into());
        status.checked_at = Some(now_iso());
        return status;
    }
    if tag == VERSION {
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
    let setup = assets.iter().find(|a| {
        a.get("name")
            .and_then(|n| n.as_str())
            .map(|n| n.ends_with("-setup.exe") || n.contains("Setup") && n.ends_with(".exe"))
            .unwrap_or(false)
    });
    let Some(asset) = setup else {
        status.state = "error".into();
        status.error = Some("No Windows installer on latest release".into());
        return status;
    };
    let url = asset
        .get("browser_download_url")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if url.is_empty() {
        status.state = "error".into();
        status.error = Some("Installer URL missing".into());
        return status;
    }
    status.state = "downloading".into();
    status.percent = Some(0);
    status.message = Some("Downloading update…".into());

    let dest = app_data_dir().join("updates");
    let _ = std::fs::create_dir_all(&dest);
    let file_name = asset
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("Gchat-setup.exe");
    let dest_file = dest.join(file_name);
    match ureq::get(url).set("User-Agent", &agent).call() {
        Ok(resp) => {
            let mut reader = resp.into_reader();
            match std::fs::File::create(&dest_file) {
                Ok(mut out) => {
                    if std::io::copy(&mut reader, &mut out).is_ok() {
                        status.state = "ready".into();
                        status.percent = Some(100);
                        status.message = Some("Update ready to install.".into());
                        let _ = std::process::Command::new(&dest_file).spawn();
                    } else {
                        status.state = "error".into();
                        status.error = Some("Failed to write installer".into());
                    }
                }
                Err(e) => {
                    status.state = "error".into();
                    status.error = Some(e.to_string());
                }
            }
        }
        Err(e) => {
            status.state = "error".into();
            status.error = Some(e.to_string());
        }
    }
    status
}

fn apply_webview_env() {
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        WEBVIEW_MEMORY_BROWSER_ARGS,
    );
}

fn main() {
    apply_webview_env();

    let instance = SingleInstance::new(APP_ID).expect("single instance");
    if !instance.is_single() {
        // Best-effort: another instance owns the app.
        return;
    }

    let state = Arc::new(AppState::default());
    {
        let mut us = state.update_status.lock().unwrap();
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
    let window = window_builder.build(&event_loop).expect("window");

    let proxy_ipc = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_initialization_script(BRIDGE_JS)
        .with_url(OFFICIAL_SERVER_URL)
        .with_ipc_handler(move |message| {
            let _ = proxy_ipc.send_event(UserEvent::Ipc(message.body().to_string()));
        })
        .with_navigation_handler(|url| {
            if let Ok(parsed) = Url::parse(&url) {
                if is_official_url(&parsed)
                    || url.starts_with("about:")
                    || url.starts_with("data:")
                {
                    return true;
                }
                if is_safe_external(&parsed) {
                    let _ = open::that(url);
                }
                return false;
            }
            true
        })
        .with_new_window_req_handler(|url| {
            if let Ok(parsed) = Url::parse(&url) {
                if is_safe_external(&parsed) {
                    let _ = open::that(url);
                }
            }
            false
        })
        .build(&window)
        .expect("webview");

    let webview = Rc::new(RefCell::new(webview));

    // Tray
    let open_item = TrayMenuItem::with_id("open", "Open Gchat", true, None);
    let update_item = TrayMenuItem::with_id("check-updates", "Check for Updates", true, None);
    let quit_item = TrayMenuItem::with_id("quit", "Quit", true, None);
    let tray_menu = TrayMenu::new();
    let _ = tray_menu.append(&TrayMenuItem::with_id("status", "Gchat", false, None));
    let _ = tray_menu.append(&TrayPredefined::separator());
    let _ = tray_menu.append(&open_item);
    let _ = tray_menu.append(&update_item);
    let _ = tray_menu.append(&TrayPredefined::separator());
    let _ = tray_menu.append(&quit_item);

    let mut tray_builder = TrayIconBuilder::new()
        .with_menu(Box::new(tray_menu))
        .with_tooltip("Gchat")
        .with_title("Gchat");
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

    // Background updater (check only; install on demand) after 15s then every 30m.
    {
        let proxy_up = proxy.clone();
        let state_up = state.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(15));
            loop {
                let status = check_updates_sync(false);
                if let Ok(mut slot) = state_up.update_status.lock() {
                    *slot = status.clone();
                }
                let _ = proxy_up.send_event(UserEvent::UpdateStatus(status));
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
            Event::UserEvent(UserEvent::TrayOpen) | Event::UserEvent(UserEvent::ShowWindow) => {
                resume_hosted(&window, &webview, &state);
                let _ = window.set_skip_taskbar(false);
                window.set_visible(true);
                window.set_focus();
            }
            Event::UserEvent(UserEvent::TrayToggle) => {
                if window.is_visible() && window.is_focused() {
                    suspend_to_tray(&window, &webview, &state);
                } else {
                    resume_hosted(&window, &webview, &state);
                    let _ = window.set_skip_taskbar(false);
                    window.set_visible(true);
                    window.set_focus();
                }
            }
            Event::UserEvent(UserEvent::TrayCheckUpdates) => {
                let proxy_bg = proxy.clone();
                let state_bg = state.clone();
                thread::spawn(move || {
                    let status = check_updates_sync(true);
                    if let Ok(mut slot) = state_bg.update_status.lock() {
                        *slot = status.clone();
                    }
                    let _ = proxy_bg.send_event(UserEvent::UpdateStatus(status));
                });
            }
            Event::UserEvent(UserEvent::UpdateStatus(status)) => {
                push_update_status(&webview, &status);
                if let Ok(mut slot) = state.update_status.lock() {
                    *slot = status;
                }
            }
            Event::UserEvent(UserEvent::Ipc(raw)) => {
                handle_ipc(
                    &raw,
                    &window,
                    &webview,
                    &state,
                    &proxy,
                    &tray,
                );
            }
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => {
                    if !quitting {
                        suspend_to_tray(&window, &webview, &state);
                    }
                }
                WindowEvent::Resized(size) => {
                    let _ = webview.borrow().set_bounds(Rect {
                        position: wry::dpi::Position::Logical(wry::dpi::LogicalPosition::new(0.0, 0.0)),
                        size: wry::dpi::Size::Physical(wry::dpi::PhysicalSize::new(
                            size.width,
                            size.height,
                        )),
                    });
                }
                WindowEvent::Focused(true) => {
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
                _ => {}
            },
            Event::LoopDestroyed => {
                // ensure tray drops
                let _ = tray.as_ref();
            }
            _ => {}
        }

        // Keep event_loop referenced for tray
        let _ = event_loop;
    });
}

fn suspend_to_tray(
    window: &tao::window::Window,
    webview: &Rc<RefCell<wry::WebView>>,
    state: &Arc<AppState>,
) {
    // Drop SPA memory while remaining a single light process in the tray.
    let _ = webview.borrow().load_html(SUSPEND_HTML);
    state.suspended.store(true, Ordering::Release);
    state.hosted_ready.store(false, Ordering::Release);
    window.set_visible(false);
    let _ = window.set_skip_taskbar(true);
}

fn resume_hosted(
    window: &tao::window::Window,
    webview: &Rc<RefCell<wry::WebView>>,
    state: &Arc<AppState>,
) {
    if state.suspended.swap(false, Ordering::AcqRel) || !state.hosted_ready.load(Ordering::Acquire)
    {
        let _ = webview.borrow().load_url(OFFICIAL_SERVER_URL);
    }
    let _ = window.set_skip_taskbar(false);
}

fn push_update_status(webview: &Rc<RefCell<wry::WebView>>, status: &UpdateStatus) {
    if let Ok(json) = serde_json::to_string(status) {
        let _ = webview
            .borrow()
            .evaluate_script(&format!("window.__gchatDesktopUpdateStatus?.({json})"));
    }
}

fn reply(webview: &Rc<RefCell<wry::WebView>>, id: &str, value: serde_json::Value, error: Option<String>) {
    let value_json = value.to_string();
    let err_json = error
        .map(|e| format!("'{}'", e.replace('\\', "\\\\").replace('\'', "\\'")))
        .unwrap_or_else(|| "null".into());
    let _ = webview.borrow().evaluate_script(&format!(
        "window.__gchatDesktopResolve?.('{id}', {value_json}, {err_json})"
    ));
}

fn handle_ipc(
    raw: &str,
    window: &tao::window::Window,
    webview: &Rc<RefCell<wry::WebView>>,
    state: &Arc<AppState>,
    proxy: &EventLoopProxy<UserEvent>,
    tray: &Option<TrayIcon>,
) {
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
            if let Some(tray) = tray {
                let tip = if unread == 0 {
                    "Gchat".to_string()
                } else {
                    format!("Gchat — {unread} unread")
                };
                let _ = tray.set_tooltip(Some(tip));
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
            show_native_notification(title, body);
            let _ = proxy.send_event(UserEvent::ShowWindow);
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
                reply(webview, &request_id, json!(ok && enabled), None);
            }
        }
        "retry-connection" => {
            state.hosted_ready.store(false, Ordering::Release);
            state.suspended.store(false, Ordering::Release);
            let _ = webview.borrow().load_url(OFFICIAL_SERVER_URL);
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
                reply(webview, &request_id, json!(true), None);
            }
            let _ = webview.borrow().clear_all_browsing_data();
            if let Ok(exe) = std::env::current_exe() {
                let _ = std::process::Command::new(exe).spawn();
            }
            std::process::exit(0);
        }
        "reload-hosted-app" => {
            state.suspended.store(false, Ordering::Release);
            let _ = webview.borrow().load_url(OFFICIAL_SERVER_URL);
            if !request_id.is_empty() {
                reply(webview, &request_id, json!(true), None);
            }
        }
        "check-for-updates" => {
            let state = state.clone();
            let rid = request_id.clone();
            let status = check_updates_sync(false);
            if let Ok(mut slot) = state.update_status.lock() {
                *slot = status.clone();
            }
            if !rid.is_empty() {
                if let Ok(val) = serde_json::to_value(&status) {
                    reply(webview, &rid, val, None);
                }
            }
            push_update_status(webview, &status);
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
            let state = state.clone();
            let rid = request_id.clone();
            let status = check_updates_sync(true);
            if let Ok(mut slot) = state.update_status.lock() {
                *slot = status.clone();
            }
            if !rid.is_empty() {
                reply(webview, &rid, json!(true), None);
            }
            push_update_status(webview, &status);
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
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("max-old-space-size=192"));
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("disable-features=WebGPU"));
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("optimize-for-size"));
    }

    #[test]
    fn suspend_html_is_tiny() {
        assert!(SUSPEND_HTML.len() < 1024);
        assert!(SUSPEND_HTML.contains("tray"));
    }
}
