use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const STATUSES: [&str; 3] = ["todo", "doing", "done"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMeta {
    id: String,
    name: String,
    created_at: u128,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketPosition {
    id: String,
    status: String,
    order: i64,
}

#[tauri::command]
fn get_workspace_info(app: AppHandle) -> Result<WorkspaceInfo, String> {
    let base_dir = workspace_root(&app)?;
    ensure_seed_data(&base_dir)?;
    let projects = list_projects_from_disk(&base_dir)?;

    Ok(WorkspaceInfo {
        base_dir: base_dir.to_string_lossy().to_string(),
        projects,
    })
}

#[tauri::command]
fn create_project(app: AppHandle, name: String) -> Result<ProjectSummary, String> {
    let base_dir = workspace_root(&app)?;
    let name = name.trim();

    if name.is_empty() {
        return Err("Project name cannot be empty.".into());
    }

    create_project_on_disk(&base_dir, name)
}

#[tauri::command]
fn list_tickets(app: AppHandle, project_id: String) -> Result<Vec<Ticket>, String> {
    let project_dir = project_dir(&workspace_root(&app)?, &project_id)?;
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
    let project_dir = project_dir(&workspace_root(&app)?, &project_id)?;
    let ticket_id = unique_ticket_id(&title);
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
    let project_dir = project_dir(&workspace_root(&app)?, &project_id)?;
    let mut ticket = read_ticket(&project_dir, &ticket_id)?;

    ticket.title = clean_title(&title);
    ticket.body = normalize_newlines(&body).trim_end().to_string();
    ticket.status = status;
    ticket.updated_at = now_millis();

    write_ticket(&project_dir, ticket)
}

#[tauri::command]
fn reorder_tickets(
    app: AppHandle,
    project_id: String,
    positions: Vec<TicketPosition>,
) -> Result<Vec<Ticket>, String> {
    let project_dir = project_dir(&workspace_root(&app)?, &project_id)?;

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
fn delete_ticket(app: AppHandle, project_id: String, ticket_id: String) -> Result<(), String> {
    let project_dir = project_dir(&workspace_root(&app)?, &project_id)?;
    let ticket_path = ticket_path(&project_dir, &ticket_id)?;

    fs::remove_file(ticket_path).map_err(|err| err.to_string())
}

fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("projects");

    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    Ok(root)
}

fn ensure_seed_data(base_dir: &Path) -> Result<(), String> {
    let has_projects = fs::read_dir(base_dir)
        .map_err(|err| err.to_string())?
        .filter_map(Result::ok)
        .any(|entry| entry.path().is_dir());

    if has_projects {
        return Ok(());
    }

    let inbox = create_project_on_disk(base_dir, "Inbox")?;
    let project_dir = project_dir(base_dir, &inbox.id)?;
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
            id: unique_ticket_id(title),
            title: title.to_string(),
            body: body.to_string(),
            status: status.to_string(),
            order,
            created_at: now,
            updated_at: now,
            file_path: String::new(),
        };

        write_ticket(&project_dir, ticket)?;
    }

    Ok(())
}

fn create_project_on_disk(base_dir: &Path, name: &str) -> Result<ProjectSummary, String> {
    fs::create_dir_all(base_dir).map_err(|err| err.to_string())?;

    let id = unique_project_id(base_dir, name);
    let project_dir = base_dir.join(&id);
    fs::create_dir_all(project_dir.join(".todo-md")).map_err(|err| err.to_string())?;

    let meta = ProjectMeta {
        id: id.clone(),
        name: name.to_string(),
        created_at: now_millis(),
    };

    let meta_json = serde_json::to_string_pretty(&meta).map_err(|err| err.to_string())?;
    fs::write(project_dir.join(".todo-md").join("project.json"), meta_json)
        .map_err(|err| err.to_string())?;

    Ok(ProjectSummary {
        id,
        name: name.to_string(),
        path: project_dir.to_string_lossy().to_string(),
        ticket_count: 0,
    })
}

fn list_projects_from_disk(base_dir: &Path) -> Result<Vec<ProjectSummary>, String> {
    let mut projects = Vec::new();

    for entry in fs::read_dir(base_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();

        if !path.is_dir() {
            continue;
        }

        let fallback_id = entry.file_name().to_string_lossy().to_string();
        let meta = read_project_meta(&path).unwrap_or(ProjectMeta {
            id: fallback_id.clone(),
            name: title_from_slug(&fallback_id),
            created_at: 0,
        });

        projects.push(ProjectSummary {
            id: meta.id,
            name: meta.name,
            path: path.to_string_lossy().to_string(),
            ticket_count: count_markdown_files(&path)?,
        });
    }

    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(projects)
}

fn list_tickets_from_disk(project_dir: &Path) -> Result<Vec<Ticket>, String> {
    let mut tickets = Vec::new();

    for entry in fs::read_dir(project_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();

        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }

        tickets.push(parse_ticket_file(&path)?);
    }

    tickets.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then(a.order.cmp(&b.order))
            .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    Ok(tickets)
}

fn read_project_meta(project_dir: &Path) -> Result<ProjectMeta, String> {
    let meta_path = project_dir.join(".todo-md").join("project.json");
    let contents = fs::read_to_string(meta_path).map_err(|err| err.to_string())?;

    serde_json::from_str(&contents).map_err(|err| err.to_string())
}

fn count_markdown_files(project_dir: &Path) -> Result<usize, String> {
    let mut count = 0;

    for entry in fs::read_dir(project_dir).map_err(|err| err.to_string())? {
        let path = entry.map_err(|err| err.to_string())?.path();

        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            count += 1;
        }
    }

    Ok(count)
}

fn read_ticket(project_dir: &Path, ticket_id: &str) -> Result<Ticket, String> {
    let path = ticket_path(project_dir, ticket_id)?;
    parse_ticket_file(&path)
}

fn parse_ticket_file(path: &Path) -> Result<Ticket, String> {
    let contents = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let normalized = normalize_newlines(&contents);
    let file_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("ticket")
        .to_string();
    let (frontmatter, body) = split_frontmatter(&normalized);
    let now = now_millis();

    let id = frontmatter
        .get("id")
        .cloned()
        .filter(|value| safe_segment(value))
        .unwrap_or_else(|| file_id.clone());
    let status = frontmatter
        .get("status")
        .cloned()
        .filter(|value| validate_status(value).is_ok())
        .unwrap_or_else(|| "todo".to_string());
    let title = frontmatter
        .get("title")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| infer_title(&body, &file_id));

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
    fs::create_dir_all(project_dir).map_err(|err| err.to_string())?;
    ticket.title = clean_title(&ticket.title);

    if ticket.title.is_empty() {
        ticket.title = "Untitled ticket".to_string();
    }

    let path = ticket_path(project_dir, &ticket.id)?;
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

fn project_dir(base_dir: &Path, project_id: &str) -> Result<PathBuf, String> {
    if !safe_segment(project_id) {
        return Err("Invalid project id.".into());
    }

    let dir = base_dir.join(project_id);

    if !dir.is_dir() {
        return Err("Project not found.".into());
    }

    Ok(dir)
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

fn unique_project_id(base_dir: &Path, name: &str) -> String {
    let base = slugify(name);

    if !base_dir.join(&base).exists() {
        return base;
    }

    for index in 2.. {
        let candidate = format!("{base}-{index}");

        if !base_dir.join(&candidate).exists() {
            return candidate;
        }
    }

    unreachable!()
}

fn unique_ticket_id(title: &str) -> String {
    format!("{}-{}", now_millis(), slugify(title))
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

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_workspace_info,
            create_project,
            list_tickets,
            create_ticket,
            update_ticket,
            reorder_tickets,
            delete_ticket
        ])
        .run(tauri::generate_context!())
        .expect("error while running Todo MD");
}
