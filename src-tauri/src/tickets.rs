use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use crate::{
    constants::STATUSES,
    models::{Ticket, TicketPosition},
    paths::ticket_storage_dir,
    text::{clean_title, infer_title, normalize_newlines, now_millis, safe_segment, slugify},
};

const RANK_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MIN_RANK_DIGIT: char = '0';
const MIN_RANK_BYTE: u8 = b'0';
const PRIORITIES: &[&str] = &["P0", "P1", "P2", "P3", "P4"];
const SIZES: &[&str] = &["XS", "S", "M", "L", "XL"];

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
    sort_tickets(&mut tickets);

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

    ticket.status = normalize_status(&ticket.status).unwrap_or_else(|| "draft".to_string());
    ticket.rank = clean_rank(&ticket.rank).unwrap_or_else(initial_rank);

    ticket.pr_link = ticket
        .pr_link
        .take()
        .and_then(|value| clean_metadata_value(&value));
    ticket.assignee = ticket
        .assignee
        .take()
        .and_then(|value| clean_metadata_value(&value));
    ticket.priority = ticket
        .priority
        .take()
        .and_then(|value| clean_enum_value(&value, PRIORITIES));
    ticket.size = ticket
        .size
        .take()
        .and_then(|value| clean_enum_value(&value, SIZES));

    let path = ticket_write_path(&tasks_dir, &ticket)?;
    let body = ticket.body.trim_end();
    let mut contents = format!(
        "---\nid: {}\ntitle: {}\nstatus: {}\nrank: {}\ncreated_at: {}\nupdated_at: {}\n",
        ticket.id, ticket.title, ticket.status, ticket.rank, ticket.created_at, ticket.updated_at
    );
    append_optional_frontmatter(&mut contents, "pr_link", ticket.pr_link.as_deref());
    append_optional_frontmatter(&mut contents, "assignee", ticket.assignee.as_deref());
    append_optional_frontmatter(&mut contents, "priority", ticket.priority.as_deref());
    append_optional_frontmatter(&mut contents, "size", ticket.size.as_deref());
    contents.push_str("---\n\n");
    contents.push_str(body);
    contents.push('\n');

    fs::write(&path, contents).map_err(|err| err.to_string())?;
    ticket.file_path = path.to_string_lossy().to_string();

    Ok(ticket)
}

pub(crate) fn next_rank(project_dir: &Path, status: &str) -> Result<String, String> {
    let tickets = list_tickets_from_disk(project_dir)?;
    let previous_rank = tickets
        .iter()
        .filter(|ticket| ticket.status == status)
        .map(|ticket| ticket.rank.as_str())
        .max();

    rank_between(previous_rank, None)
}

pub(crate) fn apply_ticket_positions(
    project_dir: &Path,
    positions: Vec<TicketPosition>,
) -> Result<(), String> {
    for position in positions {
        validate_status(&position.status)?;
        validate_rank(&position.rank)?;
        let mut ticket = read_ticket(project_dir, &position.id)?;

        if ticket.status == position.status && ticket.rank == position.rank {
            continue;
        }

        ticket.status = position.status;
        ticket.rank = position.rank;
        ticket.updated_at = now_millis();
        write_ticket(project_dir, ticket)?;
    }

    Ok(())
}

pub(crate) fn unique_ticket_id(project_dir: &Path, title: &str) -> String {
    let base = format!("{}-{}", now_millis(), slugify(title));
    unique_ticket_id_from_base(project_dir, &base)
}

pub(crate) fn validate_rank(rank: &str) -> Result<(), String> {
    if is_valid_rank(rank) {
        Ok(())
    } else {
        Err("Invalid rank.".to_string())
    }
}

pub(crate) fn rank_between(
    previous_rank: Option<&str>,
    next_rank: Option<&str>,
) -> Result<String, String> {
    if let Some(rank) = previous_rank {
        validate_rank(rank)?;
    }

    if let Some(rank) = next_rank {
        validate_rank(rank)?;
    }

    if matches!((previous_rank, next_rank), (Some(previous), Some(next)) if previous >= next) {
        return Err("Previous rank must sort before next rank.".to_string());
    }

    Ok(midpoint(previous_rank.unwrap_or(""), next_rank))
}

#[cfg(test)]
pub(crate) fn rank_from_legacy_order(order: i64) -> String {
    legacy_order_rank_prefix(order)
}

fn rank_from_legacy_order_with_tie(order: i64, title: &str, file_path: &str) -> String {
    format!(
        "{}{}0{}V",
        legacy_order_rank_prefix(order),
        rank_tie_breaker(title),
        rank_tie_breaker(file_path)
    )
}

fn legacy_order_rank_prefix(order: i64) -> String {
    let shifted_order = i128::from(order) - i128::from(i64::MIN);

    format!("U{shifted_order:020}V")
}

fn rank_tie_breaker(value: &str) -> String {
    value
        .to_lowercase()
        .bytes()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn initial_rank() -> String {
    rank_between(None, None).unwrap_or_else(|_| "V".to_string())
}

fn clean_rank(value: &str) -> Option<String> {
    let rank = value.trim();

    if is_valid_rank(rank) {
        Some(rank.to_string())
    } else {
        None
    }
}

fn is_valid_rank(rank: &str) -> bool {
    !rank.is_empty()
        && !rank.ends_with(MIN_RANK_DIGIT)
        && rank.bytes().all(|digit| RANK_ALPHABET.contains(&digit))
}

fn midpoint(previous_rank: &str, next_rank: Option<&str>) -> String {
    let next_rank = next_rank.filter(|rank| !rank.is_empty());

    if let Some(next_rank) = next_rank {
        let mut shared_prefix_length = 0;
        let previous_bytes = previous_rank.as_bytes();
        let next_bytes = next_rank.as_bytes();

        while shared_prefix_length < next_bytes.len()
            && previous_bytes
                .get(shared_prefix_length)
                .copied()
                .unwrap_or(MIN_RANK_BYTE)
                == next_bytes[shared_prefix_length]
        {
            shared_prefix_length += 1;
        }

        if shared_prefix_length > 0 {
            let previous_suffix = previous_rank.get(shared_prefix_length..).unwrap_or("");
            return format!(
                "{}{}",
                &next_rank[..shared_prefix_length],
                midpoint(previous_suffix, Some(&next_rank[shared_prefix_length..]))
            );
        }
    }

    let previous_digit = previous_rank
        .as_bytes()
        .first()
        .map(|digit| rank_digit_index(*digit))
        .unwrap_or(0);
    let next_digit = next_rank
        .and_then(|rank| rank.as_bytes().first().copied())
        .map(rank_digit_index)
        .unwrap_or(RANK_ALPHABET.len());

    if next_digit - previous_digit > 1 {
        return char::from(RANK_ALPHABET[(previous_digit + next_digit).div_ceil(2)]).to_string();
    }

    if let Some(next_rank) = next_rank.filter(|rank| rank.len() > 1) {
        let previous_suffix = previous_rank.get(1..).unwrap_or("");
        return format!(
            "{}{}",
            &next_rank[..1],
            midpoint(previous_suffix, Some(&next_rank[1..]))
        );
    }

    let previous_suffix = previous_rank.get(1..).unwrap_or("");
    format!(
        "{}{}",
        char::from(RANK_ALPHABET[previous_digit]),
        midpoint(previous_suffix, None)
    )
}

fn rank_digit_index(digit: u8) -> usize {
    RANK_ALPHABET
        .iter()
        .position(|candidate| *candidate == digit)
        .unwrap_or(0)
}

fn sort_tickets(tickets: &mut [Ticket]) {
    tickets.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then(a.rank.cmp(&b.rank))
            .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then(a.file_path.cmp(&b.file_path))
    });
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
    if normalize_status(status).as_deref() == Some(status) {
        Ok(())
    } else {
        Err("Invalid ticket status.".into())
    }
}

pub(crate) fn normalize_status(status: &str) -> Option<String> {
    if status == "todo" {
        return Some("draft".to_string());
    }

    if STATUSES.contains(&status) {
        Some(status.to_string())
    } else {
        None
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
        .and_then(|value| normalize_status(value))
        .unwrap_or_else(|| "draft".to_string());
    let title = frontmatter
        .get("title")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| infer_title(&body, file_stem));

    let legacy_order = frontmatter
        .get("order")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let rank = frontmatter
        .get("rank")
        .and_then(|value| clean_rank(value))
        .unwrap_or_else(|| {
            rank_from_legacy_order_with_tie(legacy_order, &title, &path.to_string_lossy())
        });

    Ok(Ticket {
        id,
        title,
        body: body.trim().to_string(),
        status,
        rank,
        created_at: frontmatter
            .get("created_at")
            .and_then(|value| value.parse().ok())
            .unwrap_or(now),
        updated_at: frontmatter
            .get("updated_at")
            .and_then(|value| value.parse().ok())
            .unwrap_or(now),
        file_path: path.to_string_lossy().to_string(),
        priority: frontmatter
            .get("priority")
            .and_then(|value| clean_enum_value(value, PRIORITIES)),
        size: frontmatter
            .get("size")
            .and_then(|value| clean_enum_value(value, SIZES)),
        pr_link: frontmatter_value(&frontmatter, &["pr_link", "pr_url", "pull_request"]),
        assignee: frontmatter_value(&frontmatter, &["assignee", "codex_thread", "codex_link"]),
    })
}

fn frontmatter_value(frontmatter: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| frontmatter.get(*key))
        .and_then(|value| clean_metadata_value(value))
}

fn clean_metadata_value(value: &str) -> Option<String> {
    let cleaned = normalize_newlines(value)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn clean_enum_value(value: &str, allowed: &[&str]) -> Option<String> {
    let cleaned = clean_metadata_value(value)?.to_uppercase();

    if allowed.contains(&cleaned.as_str()) {
        Some(cleaned)
    } else {
        None
    }
}

fn append_optional_frontmatter(contents: &mut String, key: &str, value: Option<&str>) {
    let Some(value) = value else {
        return;
    };

    contents.push_str(&format!("{key}: {value}\n"));
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
