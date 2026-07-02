use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

use crate::constants::{TASKS_DIR, TASKS_STORAGE_MARKER};
use crate::text::slugify;

pub(crate) fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;

    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn default_projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("projects");

    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("workspace.json"))
}

pub(crate) fn ensure_tasks_dir(project_dir: &Path) -> Result<PathBuf, String> {
    let tasks_dir = project_dir.join(TASKS_DIR);
    fs::create_dir_all(&tasks_dir).map_err(|err| err.to_string())?;
    fs::write(tasks_dir.join(TASKS_STORAGE_MARKER), "").map_err(|err| err.to_string())?;
    Ok(tasks_dir)
}

pub(crate) fn ticket_storage_dir(project_dir: &Path) -> PathBuf {
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

pub(crate) fn unique_child_dir(parent: &Path, name: &str) -> PathBuf {
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

pub(crate) fn canonical_project_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err("Project folder not found.".into());
    }

    fs::canonicalize(path).map_err(|err| err.to_string())
}

pub(crate) fn same_path_string(left: &str, right: &str) -> bool {
    canonical_project_path(Path::new(left))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| left.to_string())
        == canonical_project_path(Path::new(right))
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| right.to_string())
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
