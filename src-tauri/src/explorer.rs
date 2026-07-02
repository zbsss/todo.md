use std::{path::Path, process::Command};

pub(crate) fn open_path_in_file_explorer(path: &Path) -> Result<(), String> {
    let (program, args) = file_explorer_command(path);

    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Could not open project folder: {err}"))
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
