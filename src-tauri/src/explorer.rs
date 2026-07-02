use std::{path::Path, process::Command};

pub(crate) fn open_path_in_file_explorer(path: &Path) -> Result<(), String> {
    let (program, args) = file_explorer_command(path);

    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Could not open project folder: {err}"))
}

pub(crate) fn open_external_url(url: &str) -> Result<(), String> {
    validate_external_url(url)?;
    let (program, args) = external_url_command(url);

    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Could not open link: {err}"))
}

pub(crate) fn validate_external_url(url: &str) -> Result<(), String> {
    if url.chars().any(char::is_control) {
        return Err("Invalid link.".into());
    }

    let Some((scheme, rest)) = url.split_once(':') else {
        return Err("Invalid link.".into());
    };
    let scheme = scheme.to_ascii_lowercase();

    if !matches!(scheme.as_str(), "http" | "https" | "codex") || !rest.starts_with("//") {
        return Err("Unsupported link.".into());
    }

    if rest.trim_start_matches('/').is_empty() {
        return Err("Invalid link.".into());
    }

    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn file_explorer_command(path: &Path) -> (&'static str, Vec<String>) {
    ("/usr/bin/open", vec![path.to_string_lossy().to_string()])
}

#[cfg(target_os = "windows")]
pub(crate) fn file_explorer_command(path: &Path) -> (&'static str, Vec<String>) {
    ("explorer", vec![path.to_string_lossy().to_string()])
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub(crate) fn file_explorer_command(path: &Path) -> (&'static str, Vec<String>) {
    ("xdg-open", vec![path.to_string_lossy().to_string()])
}

#[cfg(target_os = "macos")]
pub(crate) fn external_url_command(url: &str) -> (&'static str, Vec<String>) {
    ("/usr/bin/open", vec![url.to_string()])
}

#[cfg(target_os = "windows")]
pub(crate) fn external_url_command(url: &str) -> (&'static str, Vec<String>) {
    (
        "rundll32",
        vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
    )
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub(crate) fn external_url_command(url: &str) -> (&'static str, Vec<String>) {
    ("xdg-open", vec![url.to_string()])
}
