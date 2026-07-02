use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::{
    images::allow_project_image_assets,
    models::{ProjectRegistry, WorkspaceInfo},
    paths::{canonical_project_path, default_projects_dir, registry_path},
    projects::list_projects_from_registry,
    text::safe_segment,
};

pub(crate) fn load_project_registry(app: &AppHandle) -> Result<ProjectRegistry, String> {
    let path = registry_path(app)?;

    if !path.exists() {
        return Ok(ProjectRegistry::default());
    }

    let contents = std::fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&contents).map_err(|err| err.to_string())
}

pub(crate) fn save_project_registry(
    app: &AppHandle,
    registry: &ProjectRegistry,
) -> Result<(), String> {
    let path = registry_path(app)?;
    let contents = serde_json::to_string_pretty(registry).map_err(|err| err.to_string())?;

    std::fs::write(path, contents).map_err(|err| err.to_string())
}

pub(crate) fn workspace_info_from_registry(
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

pub(crate) fn project_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
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
