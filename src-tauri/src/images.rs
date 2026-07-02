use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

use crate::{
    constants::{MAX_IMAGE_BYTES, TASKS_DIR},
    models::SavedTicketImage,
    text::{now_millis, safe_segment},
    tickets::read_ticket,
};

pub(crate) fn save_ticket_image_to_project(
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

pub(crate) fn delete_ticket_image_from_project(
    project_dir: &Path,
    markdown_path: &str,
) -> Result<(), String> {
    let file_name = image_file_name_from_markdown_path(markdown_path)?;
    let image_path = image_storage_dir(project_dir)?.join(file_name);

    match fs::remove_file(image_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

pub(crate) fn allow_project_image_assets(
    app: &AppHandle,
    project_dir: &Path,
) -> Result<(), String> {
    let tasks_dir = project_dir.join(TASKS_DIR);

    if tasks_dir.exists() && !tasks_dir.is_dir() {
        return Ok(());
    }

    app.asset_protocol_scope()
        .allow_directory(project_image_assets_dir(project_dir), true)
        .map_err(|err| err.to_string())
}

pub(crate) fn image_file_name_from_markdown_path(markdown_path: &str) -> Result<&str, String> {
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
