use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use crate::{
    constants::{LEGACY_PROJECT_META_DIR, PROJECT_META_DIR},
    models::{ProjectDiskMeta, ProjectRecord, ProjectRegistry, ProjectSummary, Ticket},
    paths::{canonical_project_path, same_path_string, unique_child_dir},
    text::{clean_title, now_millis, safe_segment, slugify, title_from_slug},
    tickets::{count_markdown_files, unique_ticket_id, write_ticket},
};

pub(crate) fn migrate_default_projects(
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

pub(crate) fn seed_project(project_dir: &Path) -> Result<(), String> {
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
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
        };

        write_ticket(project_dir, ticket)?;
    }

    Ok(())
}

pub(crate) fn create_project_record(
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

pub(crate) fn project_summary(record: &ProjectRecord) -> Result<ProjectSummary, String> {
    let project_dir = PathBuf::from(&record.path);

    Ok(ProjectSummary {
        id: record.id.clone(),
        name: record.name.clone(),
        path: record.path.clone(),
        ticket_count: count_markdown_files(&project_dir)?,
    })
}

pub(crate) fn list_projects_from_registry(
    registry: &ProjectRegistry,
) -> Result<Vec<ProjectSummary>, String> {
    let mut projects = Vec::new();

    for record in &registry.projects {
        if Path::new(&record.path).is_dir() {
            projects.push(project_summary(record)?);
        }
    }

    Ok(projects)
}

pub(crate) fn remove_project_record(
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

pub(crate) fn reorder_project_records(
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

    for project_id in project_ids {
        if !registry
            .projects
            .iter()
            .any(|record| record.id == *project_id)
        {
            return Err("Project not found.".to_string());
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

pub(crate) fn remember_removed_project_path(registry: &mut ProjectRegistry, path: &str) {
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

pub(crate) fn forget_removed_project_path(registry: &mut ProjectRegistry, path: &str) {
    registry
        .removed_project_paths
        .retain(|candidate| !same_path_string(candidate, path));
}

pub(crate) fn is_removed_project_path(registry: &ProjectRegistry, path: &str) -> bool {
    registry
        .removed_project_paths
        .iter()
        .any(|candidate| same_path_string(candidate, path))
}

pub(crate) fn read_project_disk_meta(project_dir: &Path) -> Result<ProjectDiskMeta, String> {
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

pub(crate) fn write_project_disk_meta(
    project_dir: &Path,
    meta: &ProjectDiskMeta,
) -> Result<(), String> {
    let meta_dir = project_dir.join(PROJECT_META_DIR);
    fs::create_dir_all(&meta_dir).map_err(|err| err.to_string())?;

    let meta_json = serde_json::to_string_pretty(meta).map_err(|err| err.to_string())?;
    fs::write(meta_dir.join("project.json"), meta_json).map_err(|err| err.to_string())
}

pub(crate) fn unique_project_id(registry: &ProjectRegistry, name: &str) -> String {
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

pub(crate) fn project_id_exists(registry: &ProjectRegistry, id: &str) -> bool {
    registry.projects.iter().any(|project| project.id == id)
}
