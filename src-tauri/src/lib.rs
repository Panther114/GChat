use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageReader;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, Runtime, State, UserAttentionType, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const OFFICIAL_SERVER_URL: &str = "https://gchat.up.railway.app";
const MAX_UNREAD_COUNT: u32 = 999;
const MAX_CLIPBOARD_BYTES: usize = 16 * 1024 * 1024;
const UPDATE_START_DELAY: Duration = Duration::from_secs(15);
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(15);
const GITHUB_RELEASES_URL: &str = "https://github.com/Panther114/GChat/releases/latest";

/// Memory-oriented WebView2 flags (also applied via WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).
/// Conservative set: disable unused browser features + cap V8 heap. Avoids low-end-device-mode
/// which can increase process-tree WorkingSet for the hosted SPA.
pub const WEBVIEW_MEMORY_BROWSER_ARGS: &str = concat!(
    "--disable-features=WebGPU,TranslateUI,MediaRouter,CalculateNativeWinOcclusion,",
    "InterestFeedContentSuggestions,AutofillServerCommunication,BackForwardCache,",
    "msWebOOUI,msPdfOOUI,HardwareMediaKeyHandling ",
    "--disable-background-networking ",
    "--disable-component-update ",
    "--disable-sync ",
    "--disable-default-apps ",
    "--js-flags=--max-old-space-size=256 --optimize-for-size"
);

#[derive(Default)]
struct DesktopState {
    clipboard_file: Mutex<Option<PathBuf>>,
    hosted_renderer_ready: AtomicBool,
    last_load_error: Mutex<Option<serde_json::Value>>,
    pending_group_id: Mutex<Option<String>>,
    unread: Mutex<u32>,
    update_status: Mutex<UpdateStatus>,
    timeout_active: AtomicBool,
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
            current_version: None,
            available_version: None,
            percent: None,
            message: None,
            error: None,
            checked_at: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationPayload {
    title: Option<String>,
    body: Option<String>,
    group_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardPayload {
    base64: String,
    mime_type: String,
    filename: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionContext {
    server_url: &'static str,
    last_load_error: Option<serde_json::Value>,
}

fn normalize_unread_count(value: f64) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value.floor().min(MAX_UNREAD_COUNT as f64) as u32
}

fn is_official_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("gchat.up.railway.app")
        && url.port_or_known_default() == Some(443)
}

fn is_offline_url(url: &Url) -> bool {
    let local_host =
        url.host_str() == Some("localhost") || url.host_str() == Some("tauri.localhost");
    (url.scheme() == "tauri" || url.scheme() == "http")
        && local_host
        && url.path() == "/offline.html"
}

fn is_allowed_navigation(url: &Url) -> bool {
    is_official_url(url) || is_offline_url(url)
}

fn is_safe_external_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && !is_official_url(url)
}

fn valid_group_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn clipboard_filename(value: Option<&str>) -> String {
    let candidate = value
        .and_then(|name| Path::new(name).file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("attachment.bin");
    let sanitized: String = candidate
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, ' ' | '-' | '_' | '.' | '(' | ')')
        })
        .take(120)
        .collect();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "attachment.bin".to_string()
    } else {
        sanitized
    }
}

fn cleanup_clipboard_cache<R: Runtime>(app: &AppHandle<R>) {
    let Ok(cache_dir) = app
        .path()
        .app_cache_dir()
        .map(|path| path.join("clipboard"))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("main")
}

fn hide_to_tray<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.hide();
    let _ = window.set_skip_taskbar(true);
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Deliver a notification-click group id whenever the window is shown —
        // not only on focus changes, so toast clicks never dead-end.
        let pending = app
            .state::<Arc<DesktopState>>()
            .pending_group_id
            .lock()
            .ok()
            .and_then(|mut value| value.take());
        if let Some(group_id) = pending {
            if let Ok(group_json) = serde_json::to_string(&group_id) {
                let _ = window.eval(format!("window.__gchatDesktopFocusGroup?.({group_json})"));
            }
        }
    }
}

/// Restore when hidden/minimized/unfocused; only hide when already frontmost.
fn toggle_or_show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && !minimized && focused {
        hide_to_tray(&window);
        return;
    }
    show_main_window(app);
}

fn update_tray_menu<R: Runtime>(app: &AppHandle<R>, unread: u32) -> tauri::Result<()> {
    let status = if unread == 0 {
        "Gchat".to_string()
    } else {
        format!("Gchat ({unread} unread)")
    };
    let status = MenuItem::with_id(app, "status", status, false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let open = MenuItem::with_id(app, "open", "Open Gchat", true, None::<&str>)?;
    let update = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates",
        true,
        None::<&str>,
    )?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&status, &separator, &open, &update, &separator_two, &quit],
    )?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu))?;
        let tooltip = if unread == 0 {
            "Gchat".to_string()
        } else {
            format!("Gchat — {unread} unread")
        };
        tray.set_tooltip(Some(tooltip))?;
    }
    Ok(())
}

/// Check-only update probe (parity with the Windows thin shell): never
/// downloads, installs, or restarts — the app is only updated on an explicit
/// user action through `install_update`.
async fn check_for_updates(app: AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let Some(_update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(false);
    };
    Ok(true)
}

fn schedule_updater(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(UPDATE_START_DELAY).await;
        loop {
            if let Err(error) = check_for_updates(app.clone()).await {
                eprintln!("[updater] {error}");
            }
            tokio::time::sleep(UPDATE_CHECK_INTERVAL).await;
        }
    });
}

fn schedule_connection_timeout(app: AppHandle, state: Arc<DesktopState>) {
    if state
        .timeout_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        const MAX_AUTO_RETRIES: u32 = 3;
        for attempt in 0..=MAX_AUTO_RETRIES {
            tokio::time::sleep(CONNECTION_TIMEOUT).await;
            if state.hosted_renderer_ready.load(Ordering::Acquire) {
                state.timeout_active.store(false, Ordering::Release);
                return;
            }
            if let Ok(mut error) = state.last_load_error.lock() {
                *error = Some(serde_json::json!({
                    "errorCode": "LOAD_TIMEOUT",
                    "errorDescription": "The hosted Gchat application did not become ready.",
                    "url": OFFICIAL_SERVER_URL
                }));
            }
            if attempt < MAX_AUTO_RETRIES {
                // Slow cold starts exceed the timeout: retry automatically
                // instead of stranding the user on the offline page.
                if let Some(window) = main_window(&app) {
                    if let Ok(url) = Url::parse(OFFICIAL_SERVER_URL) {
                        let _ = window.navigate(url);
                    }
                }
            } else if let Some(window) = main_window(&app) {
                if let Ok(url) = Url::parse("tauri://localhost/offline.html") {
                    let _ = window.navigate(url);
                }
            }
        }
        state.timeout_active.store(false, Ordering::Release);
    });
}

#[tauri::command]
fn desktop_renderer_ready(state: State<'_, Arc<DesktopState>>) {
    state.hosted_renderer_ready.store(true, Ordering::Release);
    if let Ok(mut error) = state.last_load_error.lock() {
        *error = None;
    }
}

#[tauri::command]
fn set_unread_count(
    app: AppHandle,
    state: State<'_, Arc<DesktopState>>,
    count: f64,
) -> Result<(), String> {
    let unread = normalize_unread_count(count);
    let mut current = state
        .unread
        .lock()
        .map_err(|_| "Unread state unavailable")?;
    if *current == unread {
        return Ok(());
    }
    *current = unread;
    drop(current);

    if let Some(window) = main_window(&app) {
        let _ = window.set_badge_count(if unread == 0 {
            None
        } else {
            Some(unread as i64)
        });
        if unread > 0 && !window.is_focused().unwrap_or(false) {
            let _ = window.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
    update_tray_menu(&app, unread).map_err(|error| error.to_string())
}

#[tauri::command]
fn show_notification(
    app: AppHandle,
    state: State<'_, Arc<DesktopState>>,
    payload: NotificationPayload,
) -> Result<(), String> {
    if let Some(group_id) = payload.group_id.filter(|value| valid_group_id(value)) {
        *state
            .pending_group_id
            .lock()
            .map_err(|_| "Notification state unavailable")? = Some(group_id);
    }
    app.notification()
        .builder()
        .title(payload.title.unwrap_or_else(|| "Gchat".to_string()))
        .body(payload.body.unwrap_or_else(|| "New message".to_string()))
        .show()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_launch_at_startup(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_launch_at_startup(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let autostart = app.autolaunch();
    if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    }
    .map_err(|error| error.to_string())?;
    autostart.is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
fn retry_connection(app: AppHandle, state: State<'_, Arc<DesktopState>>) -> Result<bool, String> {
    let window = main_window(&app).ok_or_else(|| "Main window unavailable".to_string())?;
    state.hosted_renderer_ready.store(false, Ordering::Release);
    let url = Url::parse(OFFICIAL_SERVER_URL).map_err(|error| error.to_string())?;
    window.navigate(url).map_err(|error| error.to_string())?;
    schedule_connection_timeout(app, state.inner().clone());
    Ok(true)
}

#[tauri::command]
fn get_connection_context(state: State<'_, Arc<DesktopState>>) -> ConnectionContext {
    ConnectionContext {
        server_url: OFFICIAL_SERVER_URL,
        last_load_error: state
            .last_load_error
            .lock()
            .ok()
            .and_then(|value| value.clone()),
    }
}

#[tauri::command]
fn copy_binary_to_clipboard(
    app: AppHandle,
    state: State<'_, Arc<DesktopState>>,
    payload: ClipboardPayload,
) -> Result<bool, String> {
    if payload.base64.len() > (MAX_CLIPBOARD_BYTES * 4 / 3) + 8 {
        return Err("Clipboard payload is too large".to_string());
    }
    let bytes = STANDARD
        .decode(payload.base64.as_bytes())
        .map_err(|_| "Invalid clipboard payload".to_string())?;
    if bytes.len() > MAX_CLIPBOARD_BYTES {
        return Err("Clipboard payload is too large".to_string());
    }

    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    if payload.mime_type.starts_with("image/") {
        let decoded = ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|error| error.to_string())?
            .decode()
            .map_err(|error| error.to_string())?
            .into_rgba8();
        let (width, height) = decoded.dimensions();
        clipboard
            .set_image(ImageData {
                width: width as usize,
                height: height as usize,
                bytes: std::borrow::Cow::Owned(decoded.into_raw()),
            })
            .map_err(|error| error.to_string())?;
        return Ok(true);
    }

    if payload.mime_type.starts_with("text/") {
        let text = String::from_utf8(bytes).map_err(|_| "Invalid text attachment".to_string())?;
        clipboard
            .set_text(text)
            .map_err(|error| error.to_string())?;
        return Ok(true);
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("clipboard");
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let file_path = cache_dir.join(clipboard_filename(payload.filename.as_deref()));
    if file_path.parent() != Some(cache_dir.as_path()) {
        return Err("Invalid clipboard filename".to_string());
    }
    let mut current = state
        .clipboard_file
        .lock()
        .map_err(|_| "Clipboard state unavailable")?;
    if let Some(previous) = current.as_ref().filter(|previous| **previous != file_path) {
        let _ = std::fs::remove_file(previous);
    }
    std::fs::write(&file_path, bytes).map_err(|error| error.to_string())?;
    clipboard
        .set()
        .file_list(&[&file_path])
        .map_err(|error| error.to_string())?;
    *current = Some(file_path);
    Ok(true)
}

#[tauri::command]
fn clear_cache_and_restart(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = main_window(&app) {
        window
            .clear_all_browsing_data()
            .map_err(|error| error.to_string())?;
    }
    // The WebView2 profile clear completes asynchronously — restarting
    // immediately cancels it, so the cache clear would silently no-op.
    std::thread::sleep(std::time::Duration::from_millis(1500));
    app.restart();
}

#[tauri::command]
fn reload_hosted_app(app: AppHandle, state: State<'_, Arc<DesktopState>>) -> Result<bool, String> {
    // Full reset (same as retry_connection): clear readiness + error so a
    // failed reload is caught by the connection-timeout monitor again.
    state.hosted_renderer_ready.store(false, Ordering::Release);
    if let Ok(mut error) = state.last_load_error.lock() {
        *error = None;
    }
    let window = main_window(&app).ok_or_else(|| "Main window unavailable".to_string())?;
    let url = Url::parse(OFFICIAL_SERVER_URL).map_err(|error| error.to_string())?;
    window.navigate(url).map_err(|error| error.to_string())?;
    schedule_connection_timeout(app, state.inner().clone());
    Ok(true)
}


fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn read_update_status(state: &DesktopState) -> UpdateStatus {
    state
        .update_status
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

fn publish_update_status<R: Runtime>(app: &AppHandle<R>, state: &DesktopState, status: UpdateStatus) {
    if let Ok(mut slot) = state.update_status.lock() {
        *slot = status.clone();
    }
    if let Some(window) = main_window(app) {
        if let Ok(json) = serde_json::to_string(&status) {
            let _ = window.eval(format!(
                "window.__gchatDesktopUpdateStatus?.({json});"
            ));
        }
    }
}

#[tauri::command]
fn get_update_status(app: AppHandle, state: State<'_, Arc<DesktopState>>) -> UpdateStatus {
    let mut status = read_update_status(state.inner());
    if status.current_version.is_none() {
        status.current_version = Some(app.package_info().version.to_string());
    }
    status
}

#[tauri::command]
#[allow(non_snake_case)]
async fn check_for_updates_cmd(
    app: AppHandle,
    state: State<'_, Arc<DesktopState>>,
) -> Result<UpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    publish_update_status(
        &app,
        state.inner(),
        UpdateStatus {
            state: "checking".to_string(),
            current_version: Some(current_version.clone()),
            available_version: None,
            percent: None,
            message: Some("Checking for updates…".to_string()),
            error: None,
            checked_at: None,
        },
    );
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let available_version = update.version.clone();
            let status = UpdateStatus {
                state: "available".to_string(),
                current_version: Some(current_version),
                available_version: Some(available_version.clone()),
                percent: Some(0),
                message: Some(format!("Update {available_version} is available.")),
                error: None,
                checked_at: Some(now_iso()),
            };
            publish_update_status(&app, state.inner(), status.clone());
            Ok(status)
        }
        Ok(None) => {
            let status = UpdateStatus {
                state: "up-to-date".to_string(),
                current_version: Some(current_version),
                available_version: None,
                percent: None,
                message: Some("You are up to date.".to_string()),
                error: None,
                checked_at: Some(now_iso()),
            };
            publish_update_status(&app, state.inner(), status.clone());
            Ok(status)
        }
        Err(error) => {
            let status = UpdateStatus {
                state: "error".to_string(),
                current_version: Some(current_version),
                available_version: None,
                percent: None,
                message: None,
                error: Some(error.to_string()),
                checked_at: Some(now_iso()),
            };
            publish_update_status(&app, state.inner(), status.clone());
            Ok(status)
        }
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<bool, String> {
    // Explicit user consent path: download, install, and restart now.
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
    Ok(true)
}

#[tauri::command]
fn open_latest_release() -> Result<bool, String> {
    open::that(GITHUB_RELEASES_URL).map_err(|e| e.to_string())?;
    Ok(true)
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let url = Url::parse(OFFICIAL_SERVER_URL).expect("official server URL must be valid");
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Gchat")
        .inner_size(1100.0, 700.0)
        .min_inner_size(880.0, 600.0)
        .background_color(tauri::webview::Color(11, 16, 32, 255))
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .additional_browser_args(WEBVIEW_MEMORY_BROWSER_ARGS)
        .initialization_script(include_str!("bridge.js"))
        .on_navigation(|url| {
            if is_allowed_navigation(url) {
                true
            } else {
                if is_safe_external_url(url) {
                    let _ = open::that(url.as_str());
                }
                false
            }
        })
        .on_new_window(|url, _| {
            if is_safe_external_url(&url) {
                let _ = open::that(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .build()
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("main")
        .icon(
            app.default_window_icon()
                .expect("application icon must be configured")
                .clone(),
        )
        .tooltip("Gchat")
        // Left-click restores/toggles the window; right-click still opens the menu.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    toggle_or_show_main_window(tray.app_handle());
                }
                _ => {}
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "check-updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = check_for_updates(app).await {
                        eprintln!("[updater] {error}");
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    update_tray_menu(app, 0)
}

fn apply_webview_memory_env() {
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        WEBVIEW_MEMORY_BROWSER_ARGS,
    );
}

pub fn run() {
    apply_webview_memory_env();
    let state = Arc::new(DesktopState::default());
    tauri::Builder::default()
        .manage(state.clone())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            desktop_renderer_ready,
            set_unread_count,
            show_notification,
            get_launch_at_startup,
            set_launch_at_startup,
            retry_connection,
            get_connection_context,
            copy_binary_to_clipboard,
            clear_cache_and_restart,
            reload_hosted_app,
            get_update_status,
            check_for_updates_cmd,
            install_update,
            open_latest_release,
        ])
        .setup(move |app| {
            cleanup_clipboard_cache(app.handle());
            let window = create_window(app.handle())?;
            create_tray(app.handle())?;
            let app_handle = app.handle().clone();
            let focus_state = state.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Some(window) = main_window(&app_handle) {
                        hide_to_tray(&window);
                    }
                }
                // Minimize goes to tray (same behavior as close), not the taskbar.
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if let Some(window) = main_window(&app_handle) {
                        if window.is_minimized().unwrap_or(false) {
                            hide_to_tray(&window);
                        }
                    }
                }
                WindowEvent::Focused(true) => {
                    let pending = focus_state
                        .pending_group_id
                        .lock()
                        .ok()
                        .and_then(|mut value| value.take());
                    if let Some(group_id) = pending {
                        if let (Some(window), Ok(group_json)) =
                            (main_window(&app_handle), serde_json::to_string(&group_id))
                        {
                            let _ = window
                                .eval(format!("window.__gchatDesktopFocusGroup?.({group_json})"));
                        }
                    }
                }
                _ => {}
            });
            schedule_updater(app.handle().clone());
            schedule_connection_timeout(app.handle().clone(), state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Gchat");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unread_counts_are_bounded() {
        assert_eq!(normalize_unread_count(f64::NAN), 0);
        assert_eq!(normalize_unread_count(-2.0), 0);
        assert_eq!(normalize_unread_count(2.9), 2);
        assert_eq!(normalize_unread_count(50_000.0), MAX_UNREAD_COUNT);
    }

    #[test]
    fn only_the_official_https_origin_is_allowed() {
        let allowed = Url::parse("https://gchat.up.railway.app/chat.html").unwrap();
        let insecure = Url::parse("http://gchat.up.railway.app").unwrap();
        let lookalike = Url::parse("https://gchat.up.railway.app.evil.test").unwrap();
        let external = Url::parse("https://example.com").unwrap();
        assert!(is_official_url(&allowed));
        assert!(!is_official_url(&insecure));
        assert!(!is_official_url(&lookalike));
        assert!(!is_official_url(&external));
    }

    #[test]
    fn bundled_offline_page_is_the_only_local_navigation() {
        let offline = Url::parse("tauri://localhost/offline.html").unwrap();
        let other = Url::parse("tauri://localhost/index.html").unwrap();
        let fake = Url::parse("http://tauri.localhost.evil.test/offline.html").unwrap();
        assert!(is_allowed_navigation(&offline));
        assert!(!is_allowed_navigation(&other));
        assert!(!is_allowed_navigation(&fake));
    }

    #[test]
    fn only_http_links_can_leave_the_shell() {
        let https = Url::parse("https://example.com/help").unwrap();
        let file = Url::parse("file:///C:/sensitive.txt").unwrap();
        let script = Url::parse("javascript:alert(1)").unwrap();
        let official = Url::parse(OFFICIAL_SERVER_URL).unwrap();
        assert!(is_safe_external_url(&https));
        assert!(!is_safe_external_url(&file));
        assert!(!is_safe_external_url(&script));
        assert!(!is_safe_external_url(&official));
    }

    #[test]
    fn group_ids_are_strictly_bounded() {
        assert!(valid_group_id("28aa518e-9d54-4e65-bfe9-16bd0338c204"));
        assert!(!valid_group_id(""));
        assert!(!valid_group_id("group id"));
        assert!(!valid_group_id(&"x".repeat(129)));
    }

    #[test]
    fn clipboard_filenames_cannot_escape_the_bounded_cache() {
        assert_eq!(clipboard_filename(Some("../../secret.txt")), "secret.txt");
        assert_eq!(clipboard_filename(Some("report?.pdf")), "report.pdf");
        assert_eq!(clipboard_filename(Some("..")), "attachment.bin");
        assert_eq!(clipboard_filename(None), "attachment.bin");
    }

    #[test]
    fn webview_memory_args_cap_v8_heap_and_disable_unused_features() {
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("max-old-space-size=256"));
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("disable-features=WebGPU"));
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("optimize-for-size"));
        assert!(WEBVIEW_MEMORY_BROWSER_ARGS.contains("disable-background-networking"));
        assert!(!WEBVIEW_MEMORY_BROWSER_ARGS.contains("enable-low-end-device-mode"));
    }
}
