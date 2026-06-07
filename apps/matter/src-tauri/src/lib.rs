mod entry;
mod mirror;
mod watch;

use entry::{read_entry, write_entry};
use mirror::{query_mirror, write_mirror};
use watch::{unwatch_folder, watch_folder, WatcherStore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherStore::default())
        .invoke_handler(tauri::generate_handler![
            watch_folder,
            unwatch_folder,
            read_entry,
            write_entry,
            write_mirror,
            query_mirror
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
