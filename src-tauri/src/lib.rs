//! burrowstock — lib.rs
//!
//! Tauri command definitions. Each #[tauri::command] maps 1:1 to
//! a window.bs.* call in the frontend.
//!
//! Commands are thin — they validate inputs, call db/vision, return results.
//! No business logic lives here.

mod db;
mod vision;

use db::{DbState, ItemUpdate};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

// ── Settings ──────────────────────────────────────────────────────────────────
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    #[serde(rename = "geminiKey")]
    pub gemini_key:    String,
    #[serde(rename = "geminiModel")]
    pub gemini_model:  String,
    pub theme:         String,
    #[serde(rename = "scanPrompt")]
    pub scan_prompt:   Option<String>,
    #[serde(rename = "totalInputTokens", default)]
    pub total_input_tokens:  u64,
    #[serde(rename = "totalOutputTokens", default)]
    pub total_output_tokens: u64,
    #[serde(rename = "totalScans", default)]
    pub total_scans: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            gemini_key:          String::new(),
            gemini_model:        "gemini-3.5-flash".to_string(),
            theme:               "dark".to_string(),
            scan_prompt:         None,
            total_input_tokens:  0,
            total_output_tokens: 0,
            total_scans:         0,
        }
    }
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("settings.json")
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Settings {
    let path = settings_path(&app);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app);
    std::fs::create_dir_all(path.parent().unwrap()).ok();
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ── Locations ─────────────────────────────────────────────────────────────────
#[tauri::command]
fn list_locations(state: State<DbState>) -> Result<Vec<db::Location>, String> {
    let conn = state.0.lock().unwrap();
    db::list_locations(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn upsert_location(state: State<DbState>, id: String, label: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::upsert_location(&conn, &id, &label).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_location(state: State<DbState>, old_id: String, new_id: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::rename_location(&conn, &old_id, &new_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_location(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::delete_location(&conn, &id).map_err(|e| e.to_string())
}

// ── Items ─────────────────────────────────────────────────────────────────────
#[tauri::command]
fn list_items(state: State<DbState>, location_id: Option<String>) -> Result<Vec<db::Item>, String> {
    let conn = state.0.lock().unwrap();
    db::list_items(&conn, location_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_item(state: State<DbState>, id: i64) -> Result<db::Item, String> {
    let conn = state.0.lock().unwrap();
    db::get_item(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_item(
    state:       State<DbState>,
    location_id: String,
    name:        String,
    category:    Option<String>,
    condition:   Option<String>,
    notes:       Option<String>,
) -> Result<i64, String> {
    let conn = state.0.lock().unwrap();
    db::upsert_location(&conn, &location_id, "").map_err(|e| e.to_string())?;
    db::add_item(
        &conn,
        &location_id,
        None,
        &name,
        category.as_deref().unwrap_or("other"),
        100,
        condition.as_deref().unwrap_or("unknown"),
        notes.as_deref().unwrap_or(""),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_item(state: State<DbState>, id: i64, fields: ItemUpdate) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::update_item(&conn, id, &fields).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_item(state: State<DbState>, id: i64, name: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::update_item(&conn, id, &ItemUpdate {
        name: Some(name), category: None, condition: None, notes: None,
        item_photo: None, ebay_title: None, ebay_description: None,
        ebay_price: None, ebay_estimate: None,
    }).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_item(state: State<DbState>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::delete_item(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn move_item(state: State<DbState>, id: i64, location_id: String) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::upsert_location(&conn, &location_id, "").map_err(|e| e.to_string())?;
    db::move_item(&conn, id, &location_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_items(state: State<DbState>, query: String) -> Result<Vec<db::Item>, String> {
    let conn = state.0.lock().unwrap();
    db::search_items(&conn, &query).map_err(|e| e.to_string())
}

// ── Vision scan ───────────────────────────────────────────────────────────────
#[derive(Debug, Deserialize)]
pub struct ScanItem {
    pub name:      String,
    pub category:  Option<String>,
    pub condition: Option<String>,
    pub notes:     Option<String>,
    pub confidence:Option<i64>,
    pub location:  Option<String>,
    pub checked:   Option<bool>,
}

#[tauri::command]
async fn scan_photo(
    app:          AppHandle,
    image_path:   String,
    api_key:      String,
    model:        String,
    custom_prompt: Option<String>,
) -> Result<vision::ScanResult, String> {
    if !std::path::Path::new(&image_path).exists() {
        return Err(format!("Image not found: {}", image_path));
    }
    let result = vision::scan_image(
        &image_path, &api_key, &model,
        custom_prompt.as_deref(),
    ).await?;

    // Persist running token totals to settings
    let path = settings_path(&app);
    if let Ok(json) = std::fs::read_to_string(&path) {
        if let Ok(mut s) = serde_json::from_str::<Settings>(&json) {
            s.total_input_tokens  += result.input_tokens as u64;
            s.total_output_tokens += result.output_tokens as u64;
            s.total_scans         += 1;
            if let Ok(json) = serde_json::to_string_pretty(&s) { let _ = std::fs::write(&path, json); }
        }
    }

    Ok(result)
}

#[tauri::command]
fn get_default_prompt() -> String {
    vision::default_scan_prompt().to_string()
}

#[tauri::command]
fn get_default_listing_prompt() -> String {
    vision::default_listing_prompt().to_string()
}

#[tauri::command]
async fn save_scan(
    state:       State<'_, DbState>,
    image_path:  String,
    location_id: String,
    items:       Vec<ScanItem>,
    model:       String,
) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::upsert_location(&conn, &location_id, "").map_err(|e| e.to_string())?;
    let scan_id = db::insert_scan(&conn, &image_path, &model).map_err(|e| e.to_string())?;
    for item in items.iter().filter(|i| i.checked.unwrap_or(true)) {
        db::add_item(
            &conn,
            &location_id,
            Some(scan_id),
            &item.name,
            item.category.as_deref().unwrap_or("other"),
            item.confidence.unwrap_or(50) as i64,
            item.condition.as_deref().unwrap_or("unknown"),
            item.notes.as_deref().unwrap_or(""),
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Gemini model list ─────────────────────────────────────────────────────────
#[tauri::command]
async fn list_models(api_key: String) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let url = "https://generativelanguage.googleapis.com/v1beta/models";
    let resp: serde_json::Value = client.get(url)
        .header("x-goog-api-key", &api_key)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let models = resp["models"].as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter(|m| {
            let methods = m["supportedGenerationMethods"].as_array();
            methods.map(|ms| ms.iter().any(|v| v == "generateContent")).unwrap_or(false)
        })
        .filter(|m| {
            let name = m["name"].as_str().unwrap_or("");
            name.contains("gemini") && !name.contains("image") &&
            !name.contains("embed") && !name.contains("aqa")
        })
        .map(|m| m["name"].as_str().unwrap_or("").replace("models/", "").to_string())
        .collect();

    Ok(models)
}

// ── eBay listing generation ───────────────────────────────────────────────────
#[tauri::command]
async fn generate_listing(
    item_name:   String,
    item_cond:   String,
    item_notes:  String,
    photo_paths: Vec<String>,
    api_key:     String,
    model:       String,
) -> Result<vision::Listing, String> {
    vision::generate_listing(&item_name, &item_cond, &item_notes, &photo_paths, &api_key, &model).await
}

// ── App entry point ───────────────────────────────────────────────────────────
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .register_uri_scheme_protocol("bslocal", |_app, request| {
            // bslocal:// protocol — serves local files from disk
            // URL format: bslocal://localhost/absolute/path/to/file
            let uri  = request.uri().to_string();
            let path = uri
                .trim_start_matches("bslocal://localhost")
                .trim_start_matches("bslocal://");

            match std::fs::read(path) {
                Ok(bytes) => {
                    let mime = match std::path::Path::new(path)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_lowercase()
                        .as_str()
                    {
                        "jpg" | "jpeg" => "image/jpeg",
                        "png"          => "image/png",
                        "webp"         => "image/webp",
                        "gif"          => "image/gif",
                        _              => "application/octet-stream",
                    };
                    let len = bytes.len();
                    tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .header("Content-Length", len.to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes)
                        .unwrap()
                }
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(vec![])
                    .unwrap(),
            }
        })
        .setup(|app| {
            // Open SQLite database in app data directory
            let data_dir = app.path().app_data_dir()
                .expect("Could not get app data directory");
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("catalog.db");
            let conn    = db::open(db_path.to_str().unwrap())
                .expect("Failed to open database");
            app.manage(DbState(Mutex::new(conn)));

            // Open DevTools in development builds (Linux/macOS only — freezes WebView2 on Windows)
            #[cfg(all(debug_assertions, not(target_os = "windows")))]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // settings
            load_settings, save_settings,
            // locations
            list_locations, upsert_location, rename_location, delete_location,
            // items
            list_items, get_item, add_item, update_item,
            rename_item, delete_item, move_item, search_items,
            // vision
            scan_photo, save_scan,
            // models
            list_models,
            // ebay
            generate_listing,
            // prompts
            get_default_prompt,
            get_default_listing_prompt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running burrowstock");
}
