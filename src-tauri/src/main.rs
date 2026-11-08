// Облік магазину — версія на Rust (Tauri 2).
// Інтерфейс спільний з Electron-версією: папка ../src.
// Дані в тій самій папці, що й у Electron: %APPDATA%\Oblik\data.json,
// тому між версіями можна перемикатися без перенесення даних.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, thread, time::Duration};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;

const KEEP_BACKUPS: usize = 30;
const BRIDGE_JS: &str = include_str!("bridge.js");

fn data_dir() -> PathBuf {
    // Лише для автотестів у debug-збірці: окрема папка даних
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("OBLIK_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir().expect("немає папки даних користувача").join("Oblik")
}
fn data_file() -> PathBuf {
    data_dir().join("data.json")
}
fn backup_dir() -> PathBuf {
    data_dir().join("backups")
}

/// Текст data.json або None, якщо файлу ще нема.
/// Пошкоджений файл зберігаємо окремо, щоб не втратити.
#[tauri::command]
fn load() -> Result<Option<String>, String> {
    match fs::read_to_string(data_file()) {
        Ok(text) if serde_json::from_str::<serde_json::Value>(&text).is_ok() => Ok(Some(text)),
        Ok(_) => {
            let broken = data_file().with_extension(format!("json.broken-{}", chrono::Local::now().timestamp()));
            let _ = fs::copy(data_file(), broken);
            Ok(None)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Атомарний запис: спершу тимчасовий файл, потім перейменування.
#[tauri::command]
fn save(json: String) -> Result<(), String> {
    fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    let tmp = data_file().with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, data_file()).map_err(|e| e.to_string())?;
    daily_backup(&json).map_err(|e| e.to_string())
}

/// Одна копія на день, останні 30 днів.
fn daily_backup(json: &str) -> std::io::Result<()> {
    fs::create_dir_all(backup_dir())?;
    let day = chrono::Local::now().format("%Y-%m-%d");
    fs::write(backup_dir().join(format!("data-{day}.json")), json)?;
    let mut files: Vec<_> = fs::read_dir(backup_dir())?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("data-") && n.ends_with(".json") && n.len() == "data-YYYY-MM-DD.json".len())
        .collect();
    files.sort();
    if files.len() > KEEP_BACKUPS {
        for f in &files[..files.len() - KEEP_BACKUPS] {
            let _ = fs::remove_file(backup_dir().join(f));
        }
    }
    Ok(())
}

#[tauri::command]
fn open_data_folder() -> Result<(), String> {
    fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let opener = "xdg-open";
    std::process::Command::new(opener).arg(data_dir()).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Діалог «Зберегти як…» для CSV (Excel) або резервної копії JSON.
#[tauri::command]
async fn export_file(app: AppHandle, name: String, content: String, kind: String) -> Result<bool, String> {
    let csv = kind == "csv";
    let mut dialog = app.dialog().file().set_file_name(&name);
    if let Some(docs) = dirs::document_dir() {
        dialog = dialog.set_directory(docs);
    }
    dialog = if csv {
        dialog.add_filter("CSV (Excel)", &["csv"])
    } else {
        dialog.add_filter("Резервна копія", &["json"])
    };
    let Some(path) = dialog.blocking_save_file() else { return Ok(false) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    // BOM — щоб Excel правильно показав українські літери
    let body = if csv { format!("\u{FEFF}{content}") } else { content };
    fs::write(path, body).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        // Лише одна копія програми: повторний запуск показує відкрите вікно
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load, save, open_data_folder, export_file, quit])
        .setup(|app| {
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Облік магазину")
                .inner_size(1300.0, 850.0)
                .min_inner_size(800.0, 600.0)
                .maximized(true)
                .initialization_script(BRIDGE_JS)
                .build()?;

            // Закриття: спершу дописати незбережене, потім вийти.
            // Якщо сторінка не відповіла за 3 с — вийти все одно.
            let handle = app.handle().clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.eval("window.__oblikFlushAndQuit ? window.__oblikFlushAndQuit() : window.__TAURI_INTERNALS__.invoke('quit')");
                    }
                    let h = handle.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_secs(3));
                        h.exit(0);
                    });
                }
            });

            // Лише debug: автотест — виконати скрипт як користувач, одразу закрити вікно
            #[cfg(debug_assertions)]
            if let Ok(script) = std::env::var("OBLIK_SELFTEST") {
                let w = win.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(3));
                    let _ = w.eval(&fs::read_to_string(script).unwrap_or_default());
                    thread::sleep(Duration::from_millis(100));
                    let _ = w.close();
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("помилка запуску програми");
}
