use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use crate::{
    constants::STATUSES,
    models::Ticket,
    paths::ticket_storage_dir,
    text::{clean_title, infer_title, normalize_newlines, now_millis, safe_segment, slugify},
};

pub(crate) fn list_tickets_from_disk(project_dir: &Path) -> Result<Vec<Ticket>, String> {
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

pub(crate) fn count_markdown_files(project_dir: &Path) -> Result<usize, String> {
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

pub(crate) fn read_ticket(project_dir: &Path, ticket_id: &str) -> Result<Ticket, String> {
    list_tickets_from_disk(project_dir)?
        .into_iter()
        .find(|ticket| ticket.id == ticket_id)
        .ok_or_else(|| "Ticket not found.".to_string())
}

pub(crate) fn write_ticket(project_dir: &Path, mut ticket: Ticket) -> Result<Ticket, String> {
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

pub(crate) fn next_order(project_dir: &Path, status: &str) -> Result<i64, String> {
    let tickets = list_tickets_from_disk(project_dir)?;
    let max_order = tickets
        .iter()
        .filter(|ticket| ticket.status == status)
        .map(|ticket| ticket.order)
        .max()
        .unwrap_or(0);

    Ok(max_order + 1000)
}

pub(crate) fn unique_ticket_id(project_dir: &Path, title: &str) -> String {
    let base = format!("{}-{}", now_millis(), slugify(title));
    unique_ticket_id_from_base(project_dir, &base)
}

pub(crate) fn unique_ticket_id_from_base(project_dir: &Path, base: &str) -> String {
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

pub(crate) fn validate_status(status: &str) -> Result<(), String> {
    if STATUSES.contains(&status) {
        Ok(())
    } else {
        Err("Invalid ticket status.".into())
    }
}

pub(crate) fn split_frontmatter(contents: &str) -> (HashMap<String, String>, String) {
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

fn ticket_write_path(tasks_dir: &Path, ticket: &Ticket) -> Result<PathBuf, String> {
    if !ticket.file_path.trim().is_empty() {
        let existing_path = PathBuf::from(&ticket.file_path);

        if path_belongs_to_ticket_storage(tasks_dir, &existing_path)? {
            return Ok(existing_path);
        }
    }

    ticket_path(tasks_dir, &ticket.id)
}

fn path_belongs_to_ticket_storage(tasks_dir: &Path, ticket_path: &Path) -> Result<bool, String> {
    let tasks_dir = crate::paths::canonical_project_path(tasks_dir)?;
    let Some(parent) = ticket_path.parent() else {
        return Ok(false);
    };
    let parent = crate::paths::canonical_project_path(parent)?;

    Ok(parent == tasks_dir)
}

fn ticket_path(project_dir: &Path, ticket_id: &str) -> Result<PathBuf, String> {
    if !safe_segment(ticket_id) {
        return Err("Invalid ticket id.".into());
    }

    Ok(project_dir.join(format!("{ticket_id}.md")))
}

fn status_rank(status: &str) -> usize {
    STATUSES
        .iter()
        .position(|candidate| *candidate == status)
        .unwrap_or(usize::MAX)
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
