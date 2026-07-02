use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const STATUSES: [&str; 3] = ["todo", "doing", "done"];
const TASKS_DIR: &str = ".tasks";
const TASKS_STORAGE_MARKER: &str = ".todo-md-storage";
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const PROJECT_META_DIR: &str = ".todo.md";
const LEGACY_PROJECT_META_DIR: &str = ".todo-md";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDiskMeta {
    id: String,
    name: String,
    created_at: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    id: String,
    name: String,
    path: String,
    created_at: u128,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRegistry {
    projects: Vec<ProjectRecord>,
    #[serde(default)]
    removed_project_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    id: String,
    name: String,
    path: String,
    ticket_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    base_dir: String,
    projects: Vec<ProjectSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    id: String,
    title: String,
    body: String,
    status: String,
    order: i64,
    created_at: u128,
    updated_at: u128,
    file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedTicketImage {
    markdown_path: String,
    file_path: String,
    alt: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketPosition {
    id: String,
    status: String,
    order: i64,
}

#[tauri::command]
fn get_workspace_info(app: AppHandle) -> Result<WorkspaceInfo, String> {
    let default_projects_dir = default_projects_dir(&app)?;
    let mut registry = load_project_registry(&app)?;

    migrate_default_projects(&default_projects_dir, &mut registry)?;

    if registry.projects.is_empty() && registry.removed_project_paths.is_empty() {
        let inbox = create_project_record(&mut registry, &default_projects_dir, "Inbox")?;
        seed_project(&PathBuf::from(&inbox.path))?;
    }

    save_project_registry(&app, &registry)?;
    workspace_info_from_registry(&app, &registry)
}

#[tauri::command]
fn create_project(app: AppHandle, name: String) -> Result<ProjectSummary, String> {
    let default_projects_dir = default_projects_dir(&app)?;
    let mut registry = load_project_registry(&app)?;
    let project = create_project_record(&mut registry, &default_projects_dir, &name)?;

    allow_project_image_assets(&app, Path::new(&project.path))?;
    save_project_registry(&app, &registry)?;
    Ok(project)
}

#[tauri::command]
fn import_project(app: AppHandle, path: String) -> Result<ProjectSummary, String> {
    let mut registry = load_project_registry(&app)?;
    let project_path = canonical_project_path(Path::new(&path))?;
    let project_path_string = project_path.to_string_lossy().to_string();
    forget_removed_project_path(&mut registry, &project_path_string);

    if let Some(record) = registry
        .projects
        .iter()
        .find(|record| same_path_string(&record.path, &project_path_string))
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
fn update_project_name(
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
fn remove_project(app: AppHandle, project_id: String) -> Result<WorkspaceInfo, String> {
    let mut registry = load_project_registry(&app)?;
    let record = remove_project_record(&mut registry, &project_id)?;

    remember_removed_project_path(&mut registry, &record.path);
    save_project_registry(&app, &registry)?;
    workspace_info_from_registry(&app, &registry)
}

#[tauri::command]
fn reorder_projects(app: AppHandle, project_ids: Vec<String>) -> Result<WorkspaceInfo, String> {
    let mut registry = load_project_registry(&app)?;

    reorder_project_records(&mut registry, &project_ids)?;
    save_project_registry(&app, &registry)?;
    workspace_info_from_registry(&app, &registry)
}

#[tauri::command]
fn open_project_folder(app: AppHandle, project_id: String) -> Result<(), String> {
    let project_dir = project_dir(&app, &project_id)?;

    open_path_in_file_explorer(&project_dir)
}

#[tauri::command]
fn list_tickets(app: AppHandle, project_id: String) -> Result<Vec<Ticket>, String> {
    let project_dir = project_dir(&app, &project_id)?;
    allow_project_image_assets(&app, &project_dir)?;
    list_tickets_from_disk(&project_dir)
}

#[tauri::command]
fn create_ticket(
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
    };

    write_ticket(&project_dir, ticket)
}

#[tauri::command]
fn update_ticket(
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
fn save_ticket_image(
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
fn delete_ticket_image(
    app: AppHandle,
    project_id: String,
    markdown_path: String,
) -> Result<(), String> {
    let project_dir = project_dir(&app, &project_id)?;

    delete_ticket_image_from_project(&project_dir, &markdown_path)
}

#[tauri::command]
fn reorder_tickets(
    app: AppHandle,
    project_id: String,
    positions: Vec<TicketPosition>,
    moved_ticket_id: Option<String>,
) -> Result<Vec<Ticket>, String> {
    let project_dir = project_dir(&app, &project_id)?;

    apply_ticket_positions(&project_dir, &positions, moved_ticket_id.as_deref())
}

#[tauri::command]
fn delete_ticket(app: AppHandle, project_id: String, ticket_id: String) -> Result<(), String> {
    let project_dir = project_dir(&app, &project_id)?;
    let ticket = read_ticket(&project_dir, &ticket_id)?;

    fs::remove_file(ticket.file_path).map_err(|err| err.to_string())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;

    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn default_projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("projects");

    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("workspace.json"))
}

fn load_project_registry(app: &AppHandle) -> Result<ProjectRegistry, String> {
    let path = registry_path(app)?;

    if !path.exists() {
        return Ok(ProjectRegistry::default());
    }

    let contents = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&contents).map_err(|err| err.to_string())
}

fn save_project_registry(app: &AppHandle, registry: &ProjectRegistry) -> Result<(), String> {
    let path = registry_path(app)?;
    let contents = serde_json::to_string_pretty(registry).map_err(|err| err.to_string())?;

    fs::write(path, contents).map_err(|err| err.to_string())
}

fn workspace_info_from_registry(
    app: &AppHandle,
    registry: &ProjectRegistry,
) -> Result<WorkspaceInfo, String> {
    let default_projects_dir = default_projects_dir(app)?;
    let projects = list_projects_from_registry(registry)?;

    for project in &projects {
        allow_project_image_assets(app, Path::new(&project.path))?;
    }

    Ok(WorkspaceInfo {
        base_dir: default_projects_dir.to_string_lossy().to_string(),
        projects,
    })
}

fn migrate_default_projects(
    default_projects_dir: &Path,
    registry: &mut ProjectRegistry,
) -> Result<(), String> {
    fs::create_dir_all(default_projects_dir).map_err(|err| err.to_string())?;

    let mut registered_paths = registry
        .projects
        .iter()
        .filter_map(|record| canonical_project_path(Path::new(&record.path)).ok())
        .map(|path| path.to_string_lossy().to_string())
        .collect::<HashSet<_>>();

    for entry in fs::read_dir(default_projects_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();

        if !path.is_dir() {
            continue;
        }

        let canonical_path = canonical_project_path(&path)?;
        let canonical_path_string = canonical_path.to_string_lossy().to_string();

        if registered_paths.contains(&canonical_path_string) {
            continue;
        }

        if is_removed_project_path(registry, &canonical_path_string) {
            continue;
        }

        let disk_meta = read_project_disk_meta(&canonical_path).ok();
        let fallback_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(title_from_slug)
            .unwrap_or_else(|| "Untitled project".to_string());
        let name = disk_meta
            .as_ref()
            .map(|meta| clean_title(&meta.name))
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback_name);
        let id = disk_meta
            .as_ref()
            .map(|meta| meta.id.as_str())
            .filter(|id| safe_segment(id) && !project_id_exists(registry, id))
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| unique_project_id(registry, &name));
        let created_at = disk_meta
            .as_ref()
            .map(|meta| meta.created_at)
            .unwrap_or_else(now_millis);

        write_project_disk_meta(
            &canonical_path,
            &ProjectDiskMeta {
                id: id.clone(),
                name: name.clone(),
                created_at,
            },
        )?;

        registry.projects.push(ProjectRecord {
            id,
            name,
            path: canonical_path_string.clone(),
            created_at,
        });
        registered_paths.insert(canonical_path_string);
    }

    Ok(())
}

fn seed_project(project_dir: &Path) -> Result<(), String> {
    let now = now_millis();
    let seeds = [
        (
            "Capture app ideas",
            "Use Markdown for notes, links, and quick checklists.\n\n- Keep tickets portable\n- Make project folders easy to inspect",
            "todo",
            1000,
        ),
        (
            "Sketch board columns",
            "Columns are intentionally small for now:\n\n- To do\n- Doing\n- Done",
            "doing",
            1000,
        ),
        (
            "Keep tickets local",
            "Every card is backed by a plain `.md` file on disk.",
            "done",
            1000,
        ),
    ];

    for (title, body, status, order) in seeds {
        let ticket = Ticket {
            id: unique_ticket_id(project_dir, title),
            title: title.to_string(),
            body: body.to_string(),
            status: status.to_string(),
            order,
            created_at: now,
            updated_at: now,
            file_path: String::new(),
        };

        write_ticket(project_dir, ticket)?;
    }

    Ok(())
}

fn create_project_record(
    registry: &mut ProjectRegistry,
    default_projects_dir: &Path,
    name: &str,
) -> Result<ProjectSummary, String> {
    let name = clean_title(name);

    if name.is_empty() {
        return Err("Project name cannot be empty.".into());
    }

    let id = unique_project_id(registry, &name);
    let project_dir = unique_child_dir(default_projects_dir, &name);
    fs::create_dir_all(&project_dir).map_err(|err| err.to_string())?;
    let project_dir = canonical_project_path(&project_dir)?;
    let created_at = now_millis();

    write_project_disk_meta(
        &project_dir,
        &ProjectDiskMeta {
            id: id.clone(),
            name: name.clone(),
            created_at,
        },
    )?;

    let record = ProjectRecord {
        id,
        name,
        path: project_dir.to_string_lossy().to_string(),
        created_at,
    };

    registry.projects.push(record.clone());
    project_summary(&record)
}

fn project_summary(record: &ProjectRecord) -> Result<ProjectSummary, String> {
    let project_dir = PathBuf::from(&record.path);

    Ok(ProjectSummary {
        id: record.id.clone(),
        name: record.name.clone(),
        path: record.path.clone(),
        ticket_count: count_markdown_files(&project_dir)?,
    })
}

fn list_projects_from_registry(registry: &ProjectRegistry) -> Result<Vec<ProjectSummary>, String> {
    let mut projects = Vec::new();

    for record in &registry.projects {
        if Path::new(&record.path).is_dir() {
            projects.push(project_summary(record)?);
        }
    }

    Ok(projects)
}

fn remove_project_record(
    registry: &mut ProjectRegistry,
    project_id: &str,
) -> Result<ProjectRecord, String> {
    let index = registry
        .projects
        .iter()
        .position(|record| record.id == project_id)
        .ok_or_else(|| "Project not found.".to_string())?;

    Ok(registry.projects.remove(index))
}

fn reorder_project_records(
    registry: &mut ProjectRegistry,
    project_ids: &[String],
) -> Result<(), String> {
    let mut seen = HashSet::new();

    for project_id in project_ids {
        if !safe_segment(project_id) {
            return Err("Invalid project id.".into());
        }

        if !seen.insert(project_id.as_str()) {
            return Err("Duplicate project id.".into());
        }
    }

    let mut remaining = std::mem::take(&mut registry.projects);
    let mut ordered = Vec::with_capacity(remaining.len());

    for project_id in project_ids {
        let index = remaining
            .iter()
            .position(|record| record.id == *project_id)
            .ok_or_else(|| "Project not found.".to_string())?;

        ordered.push(remaining.remove(index));
    }

    ordered.extend(remaining);
    registry.projects = ordered;

    Ok(())
}

fn remember_removed_project_path(registry: &mut ProjectRegistry, path: &str) {
    let normalized = canonical_project_path(Path::new(path))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string());

    if !registry
        .removed_project_paths
        .iter()
        .any(|candidate| same_path_string(candidate, &normalized))
    {
        registry.removed_project_paths.push(normalized);
    }
}

fn forget_removed_project_path(registry: &mut ProjectRegistry, path: &str) {
    registry
        .removed_project_paths
        .retain(|candidate| !same_path_string(candidate, path));
}

fn is_removed_project_path(registry: &ProjectRegistry, path: &str) -> bool {
    registry
        .removed_project_paths
        .iter()
        .any(|candidate| same_path_string(candidate, path))
}

fn open_path_in_file_explorer(path: &Path) -> Result<(), String> {
    let (program, args) = file_explorer_command(path);

    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Could not open project folder: {err}"))
}

#[cfg(target_os = "macos")]
fn file_explorer_command(path: &Path) -> (&'static str, Vec<String>) {
    ("/usr/bin/open", vec![path.to_string_lossy().to_string()])
}

#[cfg(target_os = "windows")]
fn file_explorer_command(path: &Path) -> (&'static str, Vec<String>) {
    ("explorer", vec![path.to_string_lossy().to_string()])
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn file_explorer_command(path: &Path) -> (&'static str, Vec<String>) {
    ("xdg-open", vec![path.to_string_lossy().to_string()])
}

fn read_project_disk_meta(project_dir: &Path) -> Result<ProjectDiskMeta, String> {
    let meta_path = project_dir.join(PROJECT_META_DIR).join("project.json");
    let contents = fs::read_to_string(&meta_path)
        .or_else(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                fs::read_to_string(
                    project_dir
                        .join(LEGACY_PROJECT_META_DIR)
                        .join("project.json"),
                )
            } else {
                Err(err)
            }
        })
        .map_err(|err| err.to_string())?;

    serde_json::from_str(&contents).map_err(|err| err.to_string())
}

fn write_project_disk_meta(project_dir: &Path, meta: &ProjectDiskMeta) -> Result<(), String> {
    let meta_dir = project_dir.join(PROJECT_META_DIR);
    fs::create_dir_all(&meta_dir).map_err(|err| err.to_string())?;

    let meta_json = serde_json::to_string_pretty(meta).map_err(|err| err.to_string())?;
    fs::write(meta_dir.join("project.json"), meta_json).map_err(|err| err.to_string())
}

fn project_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    if !safe_segment(project_id) {
        return Err("Invalid project id.".into());
    }

    let registry = load_project_registry(app)?;
    let record = registry
        .projects
        .iter()
        .find(|record| record.id == project_id)
        .ok_or_else(|| "Project not found.".to_string())?;
    let path = canonical_project_path(Path::new(&record.path))?;

    if !path.is_dir() {
        return Err("Project folder not found.".into());
    }

    Ok(path)
}

fn list_tickets_from_disk(project_dir: &Path) -> Result<Vec<Ticket>, String> {
    let mut tickets = Vec::new();
    let mut paths = Vec::new();
    let tasks_dir = ticket_storage_dir(project_dir);

    for entry in fs::read_dir(tasks_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();

        if entry
            .file_type()
            .map_err(|err| err.to_string())?
            .is_symlink()
        {
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }

        paths.push(path);
    }

    paths.sort();

    for path in paths {
        tickets.push(parse_ticket_file(&path)?);
    }

    normalize_ticket_ids(&mut tickets);
    tickets.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then(a.order.cmp(&b.order))
            .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then(a.file_path.cmp(&b.file_path))
    });

    Ok(tickets)
}

fn normalize_ticket_ids(tickets: &mut [Ticket]) {
    let mut used = HashSet::new();

    for ticket in tickets {
        if used.insert(ticket.id.clone()) {
            continue;
        }

        let file_stem = Path::new(&ticket.file_path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(slugify)
            .unwrap_or_else(|| "ticket".to_string());
        let base = format!("{}-{}", ticket.id, file_stem);

        ticket.id = unique_ticket_id_from_used(&used, &base);
        used.insert(ticket.id.clone());
    }
}

fn count_markdown_files(project_dir: &Path) -> Result<usize, String> {
    let mut count = 0;
    let tasks_dir = ticket_storage_dir(project_dir);

    for entry in fs::read_dir(tasks_dir).map_err(|err| err.to_string())? {
        let path = entry.map_err(|err| err.to_string())?.path();

        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            count += 1;
        }
    }

    Ok(count)
}

fn read_ticket(project_dir: &Path, ticket_id: &str) -> Result<Ticket, String> {
    list_tickets_from_disk(project_dir)?
        .into_iter()
        .find(|ticket| ticket.id == ticket_id)
        .ok_or_else(|| "Ticket not found.".to_string())
}

fn apply_ticket_positions(
    project_dir: &Path,
    positions: &[TicketPosition],
    moved_ticket_id: Option<&str>,
) -> Result<Vec<Ticket>, String> {
    let moved_ticket_id = moved_ticket_id.and_then(|id| {
        let trimmed = id.trim();

        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    for position in positions {
        validate_status(&position.status)?;
    }

    if let Some(moved_ticket_id) = moved_ticket_id {
        if !positions
            .iter()
            .any(|position| position.id == moved_ticket_id)
        {
            return Err("Moved ticket not found.".to_string());
        }
    }

    let updated_at = now_millis();

    for position in positions {
        let mut ticket = read_ticket(project_dir, &position.id)?;
        let has_changes = ticket.status != position.status || ticket.order != position.order;

        if !has_changes {
            continue;
        }

        ticket.status = position.status.clone();
        ticket.order = position.order;

        if moved_ticket_id.map_or(true, |moved_ticket_id| moved_ticket_id == ticket.id) {
            ticket.updated_at = updated_at;
        }

        write_ticket(project_dir, ticket)?;
    }

    list_tickets_from_disk(project_dir)
}

fn parse_ticket_file(path: &Path) -> Result<Ticket, String> {
    let contents = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let normalized = normalize_newlines(&contents);
    let file_stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("ticket");
    let (frontmatter, body) = split_frontmatter(&normalized);
    let now = now_millis();

    let id = frontmatter
        .get("id")
        .map(|value| value.trim().to_string())
        .filter(|value| safe_segment(value))
        .unwrap_or_else(|| slugify(file_stem));
    let status = frontmatter
        .get("status")
        .cloned()
        .filter(|value| validate_status(value).is_ok())
        .unwrap_or_else(|| "todo".to_string());
    let title = frontmatter
        .get("title")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| infer_title(&body, file_stem));

    Ok(Ticket {
        id,
        title,
        body: body.trim().to_string(),
        status,
        order: frontmatter
            .get("order")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        created_at: frontmatter
            .get("created_at")
            .and_then(|value| value.parse().ok())
            .unwrap_or(now),
        updated_at: frontmatter
            .get("updated_at")
            .and_then(|value| value.parse().ok())
            .unwrap_or(now),
        file_path: path.to_string_lossy().to_string(),
    })
}

fn write_ticket(project_dir: &Path, mut ticket: Ticket) -> Result<Ticket, String> {
    let tasks_dir = ticket_storage_dir(project_dir);
    fs::create_dir_all(&tasks_dir).map_err(|err| err.to_string())?;
    ticket.title = clean_title(&ticket.title);

    if ticket.title.is_empty() {
        ticket.title = "Untitled ticket".to_string();
    }

    if !safe_segment(&ticket.id) {
        ticket.id = slugify(&ticket.id);
    }

    let path = ticket_write_path(&tasks_dir, &ticket)?;
    let body = ticket.body.trim_end();
    let contents = format!(
        "---\nid: {}\ntitle: {}\nstatus: {}\norder: {}\ncreated_at: {}\nupdated_at: {}\n---\n\n{}\n",
        ticket.id,
        ticket.title,
        ticket.status,
        ticket.order,
        ticket.created_at,
        ticket.updated_at,
        body
    );

    fs::write(&path, contents).map_err(|err| err.to_string())?;
    ticket.file_path = path.to_string_lossy().to_string();

    Ok(ticket)
}

fn ticket_write_path(tasks_dir: &Path, ticket: &Ticket) -> Result<PathBuf, String> {
    if !ticket.file_path.trim().is_empty() {
        let existing_path = PathBuf::from(&ticket.file_path);

        if path_belongs_to_ticket_storage(tasks_dir, &existing_path)? {
            return Ok(existing_path);
        }
    }

    ticket_path(tasks_dir, &ticket.id)
}

fn save_ticket_image_to_project(
    project_dir: &Path,
    ticket_id: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<SavedTicketImage, String> {
    if !safe_segment(ticket_id) {
        return Err("Invalid ticket id.".into());
    }

    if bytes.is_empty() {
        return Err("Image data cannot be empty.".into());
    }

    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image is too large.".into());
    }

    let extension = image_extension(mime_type)?;
    validate_image_bytes(mime_type, bytes)?;
    read_ticket(project_dir, ticket_id)?;

    let images_dir = image_storage_dir(project_dir)?;
    fs::create_dir_all(&images_dir).map_err(|err| err.to_string())?;

    let file_stem = format!("{}-{}", now_millis(), ticket_id);
    let file_name = unique_image_file_name(&images_dir, &file_stem, extension);
    let image_path = images_dir.join(&file_name);

    fs::write(&image_path, bytes).map_err(|err| err.to_string())?;

    Ok(SavedTicketImage {
        markdown_path: format!("images/{file_name}"),
        file_path: image_path.to_string_lossy().to_string(),
        alt: "Pasted image".to_string(),
    })
}

fn delete_ticket_image_from_project(project_dir: &Path, markdown_path: &str) -> Result<(), String> {
    let file_name = image_file_name_from_markdown_path(markdown_path)?;
    let image_path = image_storage_dir(project_dir)?.join(file_name);

    match fs::remove_file(image_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

fn image_storage_dir(project_dir: &Path) -> Result<PathBuf, String> {
    let tasks_dir = project_dir.join(TASKS_DIR);

    if tasks_dir.exists() && !tasks_dir.is_dir() {
        return Err(".tasks exists but is not a directory.".into());
    }

    Ok(project_image_assets_dir(project_dir))
}

fn project_image_assets_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(TASKS_DIR).join("images")
}

fn allow_project_image_assets(app: &AppHandle, project_dir: &Path) -> Result<(), String> {
    let tasks_dir = project_dir.join(TASKS_DIR);

    if tasks_dir.exists() && !tasks_dir.is_dir() {
        return Ok(());
    }

    app.asset_protocol_scope()
        .allow_directory(project_image_assets_dir(project_dir), true)
        .map_err(|err| err.to_string())
}

fn image_file_name_from_markdown_path(markdown_path: &str) -> Result<&str, String> {
    let Some(file_name) = markdown_path.strip_prefix("images/") else {
        return Err("Invalid image path.".into());
    };

    if file_name.is_empty()
        || file_name.starts_with('.')
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || !file_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("Invalid image path.".into());
    }

    Ok(file_name)
}

fn image_extension(mime_type: &str) -> Result<&'static str, String> {
    match mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        "image/bmp" => Ok("bmp"),
        _ => Err("Unsupported image type.".into()),
    }
}

fn validate_image_bytes(mime_type: &str, bytes: &[u8]) -> Result<(), String> {
    let mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let is_valid = match mime_type.as_str() {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/bmp" => bytes.starts_with(b"BM"),
        _ => false,
    };

    if is_valid {
        Ok(())
    } else {
        Err("Image data does not match its type.".into())
    }
}

fn unique_image_file_name(images_dir: &Path, file_stem: &str, extension: &str) -> String {
    let first = format!("{file_stem}.{extension}");

    if !images_dir.join(&first).exists() {
        return first;
    }

    for index in 2.. {
        let candidate = format!("{file_stem}-{index}.{extension}");

        if !images_dir.join(&candidate).exists() {
            return candidate;
        }
    }

    unreachable!()
}

fn path_belongs_to_ticket_storage(tasks_dir: &Path, ticket_path: &Path) -> Result<bool, String> {
    let tasks_dir = canonical_project_path(tasks_dir)?;
    let Some(parent) = ticket_path.parent() else {
        return Ok(false);
    };
    let parent = canonical_project_path(parent)?;

    Ok(parent == tasks_dir)
}

fn split_frontmatter(contents: &str) -> (HashMap<String, String>, String) {
    if !contents.starts_with("---\n") {
        return (HashMap::new(), contents.to_string());
    }

    let Some(end) = contents[4..].find("\n---\n") else {
        return (HashMap::new(), contents.to_string());
    };

    let meta_block = &contents[4..4 + end];
    let body = contents[4 + end + 5..].to_string();
    let mut meta = HashMap::new();

    for line in meta_block.lines() {
        if let Some((key, value)) = line.split_once(':') {
            meta.insert(key.trim().to_string(), value.trim().to_string());
        }
    }

    (meta, body)
}

fn ticket_path(project_dir: &Path, ticket_id: &str) -> Result<PathBuf, String> {
    if !safe_segment(ticket_id) {
        return Err("Invalid ticket id.".into());
    }

    Ok(project_dir.join(format!("{ticket_id}.md")))
}

fn next_order(project_dir: &Path, status: &str) -> Result<i64, String> {
    let tickets = list_tickets_from_disk(project_dir)?;
    let max_order = tickets
        .iter()
        .filter(|ticket| ticket.status == status)
        .map(|ticket| ticket.order)
        .max()
        .unwrap_or(0);

    Ok(max_order + 1000)
}

fn unique_project_id(registry: &ProjectRegistry, name: &str) -> String {
    let base = slugify(name);

    if !project_id_exists(registry, &base) {
        return base;
    }

    for index in 2.. {
        let candidate = format!("{base}-{index}");

        if !project_id_exists(registry, &candidate) {
            return candidate;
        }
    }

    unreachable!()
}

fn project_id_exists(registry: &ProjectRegistry, id: &str) -> bool {
    registry.projects.iter().any(|project| project.id == id)
}

fn unique_child_dir(parent: &Path, name: &str) -> PathBuf {
    let base = slugify(name);
    let first = parent.join(&base);

    if !first.exists() {
        return first;
    }

    for index in 2.. {
        let candidate = parent.join(format!("{base}-{index}"));

        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!()
}

fn unique_ticket_id(project_dir: &Path, title: &str) -> String {
    let base = format!("{}-{}", now_millis(), slugify(title));
    unique_ticket_id_from_base(project_dir, &base)
}

fn unique_ticket_id_from_base(project_dir: &Path, base: &str) -> String {
    let tasks_dir = ticket_storage_dir(project_dir);

    if !tasks_dir.join(format!("{base}.md")).exists() {
        return base.to_string();
    }

    for index in 2.. {
        let candidate = format!("{base}-{index}");

        if !tasks_dir.join(format!("{candidate}.md")).exists() {
            return candidate;
        }
    }

    unreachable!()
}

fn ensure_tasks_dir(project_dir: &Path) -> Result<PathBuf, String> {
    let tasks_dir = project_dir.join(TASKS_DIR);
    fs::create_dir_all(&tasks_dir).map_err(|err| err.to_string())?;
    fs::write(tasks_dir.join(TASKS_STORAGE_MARKER), "").map_err(|err| err.to_string())?;
    Ok(tasks_dir)
}

fn ticket_storage_dir(project_dir: &Path) -> PathBuf {
    let tasks_dir = project_dir.join(TASKS_DIR);

    if tasks_dir.is_dir()
        && (tasks_dir.join(TASKS_STORAGE_MARKER).is_file()
            || directory_contains_markdown(&tasks_dir)
            || directory_is_empty(&tasks_dir))
    {
        tasks_dir
    } else {
        project_dir.to_path_buf()
    }
}

fn directory_contains_markdown(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("md"))
        })
        .unwrap_or(false)
}

fn directory_is_empty(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

fn unique_ticket_id_from_used(used: &HashSet<String>, base: &str) -> String {
    if !used.contains(base) {
        return base.to_string();
    }

    for index in 2.. {
        let candidate = format!("{base}-{index}");

        if !used.contains(&candidate) {
            return candidate;
        }
    }

    unreachable!()
}

fn clean_title(title: &str) -> String {
    title
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn infer_title(body: &str, fallback: &str) -> String {
    body.lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(clean_title))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| title_from_slug(fallback))
}

fn title_from_slug(slug: &str) -> String {
    let title = slug
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if title.is_empty() {
        "Untitled".to_string()
    } else {
        title
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if ch.is_whitespace() || matches!(ch, '-' | '_' | '.') {
            Some('-')
        } else {
            None
        };

        if let Some(ch) = next {
            if ch == '-' {
                if !last_was_dash && !slug.is_empty() {
                    slug.push(ch);
                }
                last_was_dash = true;
            } else {
                slug.push(ch);
                last_was_dash = false;
            }
        }
    }

    let slug = slug.trim_matches('-').to_string();

    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

fn safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

fn validate_status(status: &str) -> Result<(), String> {
    if STATUSES.contains(&status) {
        Ok(())
    } else {
        Err("Invalid ticket status.".into())
    }
}

fn status_rank(status: &str) -> usize {
    STATUSES
        .iter()
        .position(|candidate| *candidate == status)
        .unwrap_or(usize::MAX)
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn canonical_project_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err("Project folder not found.".into());
    }

    fs::canonicalize(path).map_err(|err| err.to_string())
}

fn same_path_string(left: &str, right: &str) -> bool {
    canonical_project_path(Path::new(left))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| left.to_string())
        == canonical_project_path(Path::new(right))
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| right.to_string())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_workspace_info,
            create_project,
            import_project,
            update_project_name,
            remove_project,
            reorder_projects,
            open_project_folder,
            list_tickets,
            create_ticket,
            update_ticket,
            save_ticket_image,
            delete_ticket_image,
            reorder_tickets,
            delete_ticket
        ])
        .run(tauri::generate_context!())
        .expect("error while running todo.md");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("todo-md-{name}-{}", now_millis()));
        fs::create_dir_all(&dir).expect("create temp project");
        dir
    }

    fn project_record(id: &str, name: &str, path: &Path) -> ProjectRecord {
        ProjectRecord {
            id: id.to_string(),
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            created_at: now_millis(),
        }
    }

    #[test]
    fn project_metadata_uses_todo_dot_md_with_legacy_fallback() {
        let dir = temp_project_dir("project-meta");
        let meta = ProjectDiskMeta {
            id: "inbox".to_string(),
            name: "Inbox".to_string(),
            created_at: 42,
        };

        write_project_disk_meta(&dir, &meta).expect("write project metadata");
        assert!(dir.join(PROJECT_META_DIR).join("project.json").exists());

        let current = read_project_disk_meta(&dir).expect("read current project metadata");
        assert_eq!(current.id, "inbox");
        assert_eq!(current.name, "Inbox");
        assert_eq!(current.created_at, 42);

        let legacy_dir = temp_project_dir("legacy-project-meta");
        let legacy_meta_dir = legacy_dir.join(LEGACY_PROJECT_META_DIR);
        fs::create_dir_all(&legacy_meta_dir).expect("create legacy metadata dir");
        fs::write(
            legacy_meta_dir.join("project.json"),
            serde_json::to_string(&ProjectDiskMeta {
                id: "legacy".to_string(),
                name: "Legacy".to_string(),
                created_at: 7,
            })
            .expect("serialize legacy metadata"),
        )
        .expect("write legacy metadata");

        let legacy = read_project_disk_meta(&legacy_dir).expect("read legacy project metadata");
        assert_eq!(legacy.id, "legacy");
        assert_eq!(legacy.name, "Legacy");
        assert_eq!(legacy.created_at, 7);

        fs::remove_dir_all(dir).expect("cleanup");
        fs::remove_dir_all(legacy_dir).expect("cleanup legacy");
    }

    #[test]
    fn tasks_directory_is_used_for_ticket_storage_when_present() {
        let dir = temp_project_dir("tasks-storage");
        let tasks_dir = ensure_tasks_dir(&dir).expect("create tasks dir");

        fs::write(dir.join("root-note.md"), "# Root note").expect("write root note");

        let ticket = write_ticket(
            &dir,
            Ticket {
                id: "planned-work".to_string(),
                title: "Planned work".to_string(),
                body: "Stored away from the imported folder root.".to_string(),
                status: "todo".to_string(),
                order: 1000,
                created_at: 1,
                updated_at: 1,
                file_path: String::new(),
            },
        )
        .expect("write ticket");

        let expected_path = tasks_dir.join("planned-work.md");
        assert_eq!(ticket.file_path, expected_path.to_string_lossy());
        assert!(expected_path.exists());
        assert_eq!(count_markdown_files(&dir).expect("count tickets"), 1);

        let tickets = list_tickets_from_disk(&dir).expect("list tickets");
        assert_eq!(tickets.len(), 1);
        assert_eq!(tickets[0].id, "planned-work");

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn preexisting_empty_tasks_directory_remains_ticket_storage() {
        let dir = temp_project_dir("empty-tasks-storage");
        let tasks_dir = dir.join(TASKS_DIR);
        fs::create_dir_all(&tasks_dir).expect("create unmarked tasks dir");

        let ticket = write_ticket(
            &dir,
            Ticket {
                id: "first-ticket".to_string(),
                title: "First ticket".to_string(),
                body: "Body".to_string(),
                status: "todo".to_string(),
                order: 1000,
                created_at: 1,
                updated_at: 1,
                file_path: String::new(),
            },
        )
        .expect("write ticket");

        assert_eq!(
            ticket.file_path,
            tasks_dir.join("first-ticket.md").to_string_lossy()
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn pasted_ticket_images_are_stored_under_tasks_images() {
        let dir = temp_project_dir("ticket-image");
        let tasks_dir = ensure_tasks_dir(&dir).expect("create tasks dir");
        write_ticket(
            &dir,
            Ticket {
                id: "planned-work".to_string(),
                title: "Planned work".to_string(),
                body: "Body".to_string(),
                status: "todo".to_string(),
                order: 1000,
                created_at: 1,
                updated_at: 1,
                file_path: String::new(),
            },
        )
        .expect("write ticket");

        let saved = save_ticket_image_to_project(
            &dir,
            "planned-work",
            "image/png",
            b"\x89PNG\r\n\x1a\npng bytes",
        )
        .expect("save pasted image");

        assert!(saved.markdown_path.starts_with("images/"));
        assert!(saved.markdown_path.ends_with(".png"));
        assert_eq!(saved.alt, "Pasted image");

        let image_path = PathBuf::from(&saved.file_path);
        let expected_images_dir = tasks_dir.join("images");
        assert_eq!(image_path.parent(), Some(expected_images_dir.as_path()));
        assert_eq!(
            fs::read(&image_path).expect("read saved image"),
            b"\x89PNG\r\n\x1a\npng bytes"
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn creating_image_storage_keeps_legacy_root_markdown_in_place() {
        let dir = temp_project_dir("image-storage-root-tickets");
        let root_ticket_path = dir.join("Legacy ticket.md");
        let root_note_path = dir.join("README.md");

        fs::write(
            &root_ticket_path,
            "---\nid: legacy-ticket\ntitle: Legacy ticket\nstatus: todo\n---\n\nBody",
        )
        .expect("write legacy root ticket");
        fs::write(&root_note_path, "# Notes").expect("write root note");

        let saved = save_ticket_image_to_project(
            &dir,
            "legacy-ticket",
            "image/jpeg",
            &[0xff, 0xd8, 0xff, b'j', b'p', b'g'],
        )
        .expect("save pasted image");

        assert!(root_ticket_path.exists());
        assert!(root_note_path.exists());
        assert!(PathBuf::from(saved.file_path).exists());

        let ticket = read_ticket(&dir, "legacy-ticket").expect("read root ticket");
        assert_eq!(ticket.file_path, root_ticket_path.to_string_lossy());
        assert_eq!(ticket.body, "Body");

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn pasted_ticket_images_reject_unsupported_image_types() {
        let dir = temp_project_dir("unsupported-ticket-image");
        let error = save_ticket_image_to_project(&dir, "planned-work", "image/svg+xml", b"<svg />")
            .expect_err("reject unsupported image");

        assert_eq!(error, "Unsupported image type.");

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn pasted_ticket_images_reject_mismatched_bytes() {
        let dir = temp_project_dir("mismatched-ticket-image");
        let error = save_ticket_image_to_project(&dir, "planned-work", "image/png", b"not a png")
            .expect_err("reject mismatched image bytes");

        assert_eq!(error, "Image data does not match its type.");

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn pasted_ticket_images_can_be_deleted_by_markdown_path() {
        let dir = temp_project_dir("delete-ticket-image");
        write_ticket(
            &dir,
            Ticket {
                id: "planned-work".to_string(),
                title: "Planned work".to_string(),
                body: "Body".to_string(),
                status: "todo".to_string(),
                order: 1000,
                created_at: 1,
                updated_at: 1,
                file_path: String::new(),
            },
        )
        .expect("write ticket");
        let saved =
            save_ticket_image_to_project(&dir, "planned-work", "image/gif", b"GIF89a image bytes")
                .expect("save pasted image");
        let image_path = PathBuf::from(&saved.file_path);

        assert!(image_path.exists());

        delete_ticket_image_from_project(&dir, &saved.markdown_path).expect("delete pasted image");
        assert!(!image_path.exists());

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn reordering_preserves_updated_at_for_displaced_tickets() {
        let dir = temp_project_dir("reorder-preserve-updated-at");

        for (id, order, updated_at) in [
            ("alpha", 1000, 111),
            ("bravo", 2000, 222),
            ("charlie", 3000, 333),
        ] {
            write_ticket(
                &dir,
                Ticket {
                    id: id.to_string(),
                    title: id.to_string(),
                    body: String::new(),
                    status: "todo".to_string(),
                    order,
                    created_at: 1,
                    updated_at,
                    file_path: String::new(),
                },
            )
            .expect("write ticket");
        }

        let tickets = apply_ticket_positions(
            &dir,
            &[
                TicketPosition {
                    id: "charlie".to_string(),
                    status: "todo".to_string(),
                    order: 1000,
                },
                TicketPosition {
                    id: "alpha".to_string(),
                    status: "todo".to_string(),
                    order: 2000,
                },
                TicketPosition {
                    id: "bravo".to_string(),
                    status: "todo".to_string(),
                    order: 3000,
                },
            ],
            Some("charlie"),
        )
        .expect("reorder tickets");

        let by_id = tickets
            .iter()
            .map(|ticket| (ticket.id.as_str(), ticket))
            .collect::<HashMap<_, _>>();

        assert_eq!(by_id["alpha"].order, 2000);
        assert_eq!(by_id["alpha"].updated_at, 111);
        assert_eq!(by_id["bravo"].order, 3000);
        assert_eq!(by_id["bravo"].updated_at, 222);
        assert_eq!(by_id["charlie"].order, 1000);
        assert!(by_id["charlie"].updated_at > 333);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn removing_project_record_keeps_project_files_on_disk() {
        let dir = temp_project_dir("remove-project");
        let tasks_dir = ensure_tasks_dir(&dir).expect("create tasks dir");
        let ticket_path = tasks_dir.join("keep-me.md");
        fs::write(&ticket_path, "# Keep me").expect("write ticket");
        let mut registry = ProjectRegistry {
            projects: vec![project_record("inbox", "Inbox", &dir)],
            ..ProjectRegistry::default()
        };

        let removed = remove_project_record(&mut registry, "inbox").expect("remove project record");
        remember_removed_project_path(&mut registry, &removed.path);

        assert!(registry.projects.is_empty());
        assert!(is_removed_project_path(&registry, &removed.path));
        assert!(dir.is_dir());
        assert!(tasks_dir.is_dir());
        assert!(ticket_path.exists());
        assert!(list_projects_from_registry(&registry)
            .expect("list projects")
            .is_empty());

        forget_removed_project_path(&mut registry, &removed.path);
        assert!(!is_removed_project_path(&registry, &removed.path));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn project_records_reorder_without_sorting_by_name() {
        let alpha_dir = temp_project_dir("alpha-order");
        let beta_dir = temp_project_dir("beta-order");
        let gamma_dir = temp_project_dir("gamma-order");
        let mut registry = ProjectRegistry {
            projects: vec![
                project_record("alpha", "Alpha", &alpha_dir),
                project_record("beta", "Beta", &beta_dir),
                project_record("gamma", "Gamma", &gamma_dir),
            ],
            ..ProjectRegistry::default()
        };

        reorder_project_records(&mut registry, &["gamma".to_string(), "alpha".to_string()])
            .expect("reorder projects");

        let ids = registry
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["gamma", "alpha", "beta"]);

        let visible_ids = list_projects_from_registry(&registry)
            .expect("list projects")
            .into_iter()
            .map(|project| project.id)
            .collect::<Vec<_>>();
        assert_eq!(visible_ids, vec!["gamma", "alpha", "beta"]);

        fs::remove_dir_all(alpha_dir).expect("cleanup alpha");
        fs::remove_dir_all(beta_dir).expect("cleanup beta");
        fs::remove_dir_all(gamma_dir).expect("cleanup gamma");
    }

    #[test]
    fn file_explorer_command_targets_project_folder() {
        let dir = temp_project_dir("open-project");
        let (program, args) = file_explorer_command(&dir);

        assert!(!program.is_empty());
        assert_eq!(args, vec![dir.to_string_lossy().to_string()]);

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn markdown_files_with_spaces_get_safe_ids_and_remain_editable() {
        let dir = temp_project_dir("spaces");
        let ticket_path = dir.join("Fix login.md");
        fs::write(&ticket_path, "# Fix login\n\nBody").expect("write ticket");

        let ticket = read_ticket(&dir, "fix-login").expect("read ticket by generated id");
        assert_eq!(ticket.title, "Fix login");
        assert_eq!(ticket.file_path, ticket_path.to_string_lossy());

        let updated = write_ticket(
            &dir,
            Ticket {
                title: "Fix login flow".to_string(),
                body: "Updated body".to_string(),
                ..ticket
            },
        )
        .expect("write ticket");

        assert_eq!(updated.file_path, ticket_path.to_string_lossy());
        assert!(ticket_path.exists());
        assert!(fs::read_to_string(ticket_path)
            .expect("read updated ticket")
            .contains("Fix login flow"));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn frontmatter_ids_do_not_need_to_match_filenames() {
        let dir = temp_project_dir("frontmatter");
        let ticket_path = dir.join("Actual filename.md");
        fs::write(
            &ticket_path,
            "---\nid: custom-ticket-id\ntitle: Custom title\nstatus: todo\n---\n\nBody",
        )
        .expect("write ticket");

        let ticket = read_ticket(&dir, "custom-ticket-id").expect("read ticket by frontmatter id");
        assert_eq!(ticket.file_path, ticket_path.to_string_lossy());

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn duplicate_frontmatter_ids_are_normalized_per_file() {
        let dir = temp_project_dir("duplicate-ids");
        let first_path = dir.join("First ticket.md");
        let second_path = dir.join("Second ticket.md");

        fs::write(
            &first_path,
            "---\nid: duplicate\ntitle: First ticket\nstatus: todo\n---\n\nFirst",
        )
        .expect("write first ticket");
        fs::write(
            &second_path,
            "---\nid: duplicate\ntitle: Second ticket\nstatus: todo\n---\n\nSecond",
        )
        .expect("write second ticket");

        let tickets = list_tickets_from_disk(&dir).expect("list tickets");
        let ids = tickets
            .iter()
            .map(|ticket| ticket.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["duplicate", "duplicate-second-ticket"]);

        let second = read_ticket(&dir, "duplicate-second-ticket")
            .expect("read second duplicate by normalized id");
        let updated = write_ticket(
            &dir,
            Ticket {
                title: "Second ticket edited".to_string(),
                body: "Updated second".to_string(),
                ..second
            },
        )
        .expect("write second duplicate");

        assert_eq!(updated.file_path, second_path.to_string_lossy());
        assert!(fs::read_to_string(first_path)
            .expect("read first ticket")
            .contains("First ticket"));
        assert!(fs::read_to_string(second_path)
            .expect("read second ticket")
            .contains("Second ticket edited"));

        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_markdown_files_are_not_loaded_as_tickets() {
        use std::os::unix::fs::symlink;

        let dir = temp_project_dir("symlink");
        let outside = std::env::temp_dir().join(format!("todo-md-outside-{}.md", now_millis()));
        let link = dir.join("Linked ticket.md");

        fs::write(
            &outside,
            "---\nid: outside\ntitle: Outside\nstatus: todo\n---\n\nOutside",
        )
        .expect("write outside ticket");
        symlink(&outside, &link).expect("create symlink");

        let tickets = list_tickets_from_disk(&dir).expect("list tickets");
        assert!(tickets.is_empty());

        fs::remove_file(outside).expect("cleanup outside file");
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn ticket_ids_do_not_overwrite_existing_files() {
        let dir = temp_project_dir("collisions");
        fs::write(dir.join("same-base.md"), "first").expect("write existing ticket");

        assert_eq!(
            unique_ticket_id_from_base(&dir, "same-base"),
            "same-base-2".to_string()
        );

        fs::remove_dir_all(dir).expect("cleanup");
    }
}
