use std::{fs, path::Path};
use tauri::AppHandle;

use crate::{
    explorer::open_path_in_file_explorer,
    images::{
        allow_project_image_assets, delete_ticket_image_from_project, save_ticket_image_to_project,
    },
    models::{
        ProjectDiskMeta, ProjectRecord, ProjectSummary, SavedTicketImage, Ticket, TicketPosition,
        WorkspaceInfo,
    },
    paths::{canonical_project_path, default_projects_dir, ensure_tasks_dir},
    projects::{
        create_project_record, forget_removed_project_path, migrate_default_projects,
        project_id_exists, project_summary, read_project_disk_meta, remember_removed_project_path,
        remove_project_record, reorder_project_records, seed_project, unique_project_id,
        write_project_disk_meta,
    },
    registry::{
        load_project_registry, project_dir, save_project_registry, workspace_info_from_registry,
    },
    text::{clean_title, normalize_newlines, now_millis, safe_segment, title_from_slug},
    tickets::{
        list_tickets_from_disk, next_order, read_ticket, unique_ticket_id, validate_status,
        write_ticket,
    },
};

#[tauri::command]
pub(crate) fn get_workspace_info(app: AppHandle) -> Result<WorkspaceInfo, String> {
    let default_projects_dir = default_projects_dir(&app)?;
    let mut registry = load_project_registry(&app)?;

    migrate_default_projects(&default_projects_dir, &mut registry)?;

    if registry.projects.is_empty() && registry.removed_project_paths.is_empty() {
        let inbox = create_project_record(&mut registry, &default_projects_dir, "Inbox")?;
        seed_project(Path::new(&inbox.path))?;
    }

    save_project_registry(&app, &registry)?;
    workspace_info_from_registry(&app, &registry)
}

#[tauri::command]
pub(crate) fn create_project(app: AppHandle, name: String) -> Result<ProjectSummary, String> {
    let default_projects_dir = default_projects_dir(&app)?;
    let mut registry = load_project_registry(&app)?;
    let project = create_project_record(&mut registry, &default_projects_dir, &name)?;

    allow_project_image_assets(&app, Path::new(&project.path))?;
    save_project_registry(&app, &registry)?;
    Ok(project)
}

#[tauri::command]
pub(crate) fn import_project(app: AppHandle, path: String) -> Result<ProjectSummary, String> {
    let mut registry = load_project_registry(&app)?;
    let project_path = canonical_project_path(Path::new(&path))?;
    let project_path_string = project_path.to_string_lossy().to_string();
    forget_removed_project_path(&mut registry, &project_path_string);

    if let Some(record) = registry
        .projects
        .iter()
        .find(|record| crate::paths::same_path_string(&record.path, &project_path_string))
    {
        return project_summary(record);
    }

    ensure_tasks_dir(&project_path)?;

    let disk_meta = read_project_disk_meta(&project_path).ok();
    let fallback_name = project_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(title_from_slug)
        .unwrap_or_else(|| "Imported project".to_string());
    let name = disk_meta
        .as_ref()
        .map(|meta| clean_title(&meta.name))
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_name);
    let id = disk_meta
        .as_ref()
        .map(|meta| meta.id.as_str())
        .filter(|id| safe_segment(id) && !project_id_exists(&registry, id))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| unique_project_id(&registry, &name));
    let created_at = disk_meta
        .as_ref()
        .map(|meta| meta.created_at)
        .unwrap_or_else(now_millis);

    write_project_disk_meta(
        &project_path,
        &ProjectDiskMeta {
            id: id.clone(),
            name: name.clone(),
            created_at,
        },
    )?;

    let record = ProjectRecord {
        id,
        name,
        path: project_path_string,
        created_at,
    };

    registry.projects.push(record.clone());
    save_project_registry(&app, &registry)?;
    allow_project_image_assets(&app, &project_path)?;
    project_summary(&record)
}

#[tauri::command]
pub(crate) fn update_project_name(
    app: AppHandle,
    project_id: String,
    name: String,
) -> Result<ProjectSummary, String> {
    let mut registry = load_project_registry(&app)?;
    let name = clean_title(&name);

    if name.is_empty() {
        return Err("Project name cannot be empty.".into());
    }

    let record = registry
        .projects
        .iter_mut()
        .find(|record| record.id == project_id)
        .ok_or_else(|| "Project not found.".to_string())?;

    record.name = name.clone();

    let project_path = canonical_project_path(Path::new(&record.path))?;
    let disk_meta = read_project_disk_meta(&project_path).ok();
    let created_at = disk_meta
        .as_ref()
        .map(|meta| meta.created_at)
        .unwrap_or(record.created_at);

    write_project_disk_meta(
        &project_path,
        &ProjectDiskMeta {
            id: record.id.clone(),
            name,
            created_at,
        },
    )?;

    let summary = project_summary(record)?;
    save_project_registry(&app, &registry)?;
    Ok(summary)
}

#[tauri::command]
pub(crate) fn remove_project(app: AppHandle, project_id: String) -> Result<WorkspaceInfo, String> {
    let mut registry = load_project_registry(&app)?;
    let record = remove_project_record(&mut registry, &project_id)?;

    remember_removed_project_path(&mut registry, &record.path);
    save_project_registry(&app, &registry)?;
    workspace_info_from_registry(&app, &registry)
}

#[tauri::command]
pub(crate) fn reorder_projects(
    app: AppHandle,
    project_ids: Vec<String>,
) -> Result<WorkspaceInfo, String> {
    let mut registry = load_project_registry(&app)?;

    reorder_project_records(&mut registry, &project_ids)?;
    save_project_registry(&app, &registry)?;
    workspace_info_from_registry(&app, &registry)
}

#[tauri::command]
pub(crate) fn open_project_folder(app: AppHandle, project_id: String) -> Result<(), String> {
    let project_dir = project_dir(&app, &project_id)?;

    open_path_in_file_explorer(&project_dir)
}

#[tauri::command]
pub(crate) fn list_tickets(app: AppHandle, project_id: String) -> Result<Vec<Ticket>, String> {
    let project_dir = project_dir(&app, &project_id)?;
    allow_project_image_assets(&app, &project_dir)?;
    list_tickets_from_disk(&project_dir)
}

#[tauri::command]
pub(crate) fn create_ticket(
    app: AppHandle,
    project_id: String,
    status: String,
    title: String,
) -> Result<Ticket, String> {
    validate_status(&status)?;
    let project_dir = project_dir(&app, &project_id)?;
    let ticket_id = unique_ticket_id(&project_dir, &title);
    let now = now_millis();
    let order = next_order(&project_dir, &status)?;

    let ticket = Ticket {
        id: ticket_id,
        title: clean_title(&title),
        body: String::new(),
        status,
        order,
        created_at: now,
        updated_at: now,
        file_path: String::new(),
        pr_link: None,
        branch: None,
        workspace: None,
        assignee: None,
    };

    write_ticket(&project_dir, ticket)
}

#[tauri::command]
pub(crate) fn update_ticket(
    app: AppHandle,
    project_id: String,
    ticket_id: String,
    title: String,
    body: String,
    status: String,
) -> Result<Ticket, String> {
    validate_status(&status)?;
    let project_dir = project_dir(&app, &project_id)?;
    let mut ticket = read_ticket(&project_dir, &ticket_id)?;

    ticket.title = clean_title(&title);
    ticket.body = normalize_newlines(&body).trim_end().to_string();
    ticket.status = status;
    ticket.updated_at = now_millis();

    write_ticket(&project_dir, ticket)
}

#[tauri::command]
pub(crate) fn save_ticket_image(
    app: AppHandle,
    project_id: String,
    ticket_id: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<SavedTicketImage, String> {
    let project_dir = project_dir(&app, &project_id)?;

    let saved = save_ticket_image_to_project(&project_dir, &ticket_id, &mime_type, &bytes)?;
    allow_project_image_assets(&app, &project_dir)?;

    Ok(saved)
}

#[tauri::command]
pub(crate) fn delete_ticket_image(
    app: AppHandle,
    project_id: String,
    markdown_path: String,
) -> Result<(), String> {
    let project_dir = project_dir(&app, &project_id)?;

    delete_ticket_image_from_project(&project_dir, &markdown_path)
}

#[tauri::command]
pub(crate) fn reorder_tickets(
    app: AppHandle,
    project_id: String,
    positions: Vec<TicketPosition>,
) -> Result<Vec<Ticket>, String> {
    let project_dir = project_dir(&app, &project_id)?;

    for position in positions {
        validate_status(&position.status)?;
        let mut ticket = read_ticket(&project_dir, &position.id)?;
        ticket.status = position.status;
        ticket.order = position.order;
        ticket.updated_at = now_millis();
        write_ticket(&project_dir, ticket)?;
    }

    list_tickets_from_disk(&project_dir)
}

#[tauri::command]
pub(crate) fn delete_ticket(
    app: AppHandle,
    project_id: String,
    ticket_id: String,
) -> Result<(), String> {
    let project_dir = project_dir(&app, &project_id)?;
    let ticket = read_ticket(&project_dir, &ticket_id)?;

    fs::remove_file(ticket.file_path).map_err(|err| err.to_string())
}
