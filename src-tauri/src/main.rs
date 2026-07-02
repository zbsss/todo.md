mod commands;
mod constants;
mod explorer;
mod images;
mod models;
mod paths;
mod projects;
mod registry;
#[cfg(test)]
mod tests;
mod text;
mod tickets;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_workspace_info,
            commands::create_project,
            commands::import_project,
            commands::update_project_name,
            commands::remove_project,
            commands::reorder_projects,
            commands::open_project_folder,
            commands::list_tickets,
            commands::create_ticket,
            commands::update_ticket,
            commands::save_ticket_image,
            commands::delete_ticket_image,
            commands::reorder_tickets,
            commands::delete_ticket
        ])
        .run(tauri::generate_context!())
        .expect("error while running todo.md");
}
