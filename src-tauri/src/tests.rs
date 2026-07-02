use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::{
    constants::{LEGACY_PROJECT_META_DIR, PROJECT_META_DIR, TASKS_DIR},
    explorer::file_explorer_command,
    images::{
        delete_ticket_image_from_project, image_file_name_from_markdown_path,
        save_ticket_image_to_project,
    },
    models::{ProjectDiskMeta, ProjectRecord, ProjectRegistry, Ticket},
    paths::ensure_tasks_dir,
    projects::{
        forget_removed_project_path, is_removed_project_path, list_projects_from_registry,
        read_project_disk_meta, remember_removed_project_path, remove_project_record,
        reorder_project_records, write_project_disk_meta,
    },
    text::now_millis,
    tickets::{
        count_markdown_files, list_tickets_from_disk, read_ticket, split_frontmatter,
        unique_ticket_id_from_base, write_ticket,
    },
};

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
fn split_frontmatter_parses_complete_header_and_preserves_body_markers() {
    let (frontmatter, body) = split_frontmatter(
        "---\nid: ticket-1\ntitle: Build: parser\n status : doing \nignored\n---\nBody\n---\nStill body",
    );

    assert_eq!(frontmatter.get("id"), Some(&"ticket-1".to_string()));
    assert_eq!(frontmatter.get("title"), Some(&"Build: parser".to_string()));
    assert_eq!(frontmatter.get("status"), Some(&"doing".to_string()));
    assert_eq!(body, "Body\n---\nStill body");
}

#[test]
fn split_frontmatter_ignores_missing_or_misplaced_delimiters() {
    let unclosed = "---\nid: ticket-1\nBody without closing marker";
    let (frontmatter, body) = split_frontmatter(unclosed);
    assert!(frontmatter.is_empty());
    assert_eq!(body, unclosed);

    let not_at_start = "# Title\n---\nid: ticket-1\n---\nBody";
    let (frontmatter, body) = split_frontmatter(not_at_start);
    assert!(frontmatter.is_empty());
    assert_eq!(body, not_at_start);
}

#[test]
fn agent_metadata_is_read_and_preserved_when_tickets_are_written() {
    let dir = temp_project_dir("agent-metadata");
    let ticket_path = dir.join("agent-ticket.md");
    fs::write(
        &ticket_path,
        "---\nid: agent-ticket\ntitle: Agent task\nstatus: doing\norder: 1000\ncreated_at: 10\nupdated_at: 20\npr_link: https://github.com/zbsss/todo.md/pull/22\nbranch: codex/ai-agent-metadata\nworkspace: /tmp/todo-md-workspace\nassignee: codex://threads/019f239d-dd6d-7451-856c-3847cadaf912\n---\n\nBody",
    )
    .expect("write ticket with agent metadata");

    let ticket = read_ticket(&dir, "agent-ticket").expect("read ticket");
    assert_eq!(
        ticket.pr_link.as_deref(),
        Some("https://github.com/zbsss/todo.md/pull/22")
    );
    assert_eq!(ticket.branch.as_deref(), Some("codex/ai-agent-metadata"));
    assert_eq!(ticket.workspace.as_deref(), Some("/tmp/todo-md-workspace"));
    assert_eq!(
        ticket.assignee.as_deref(),
        Some("codex://threads/019f239d-dd6d-7451-856c-3847cadaf912")
    );

    let updated = write_ticket(
        &dir,
        Ticket {
            body: "Updated body".to_string(),
            ..ticket
        },
    )
    .expect("write updated ticket");
    let contents = fs::read_to_string(&updated.file_path).expect("read updated ticket");

    assert!(contents.contains("\npr_link: https://github.com/zbsss/todo.md/pull/22\n"));
    assert!(contents.contains("\nbranch: codex/ai-agent-metadata\n"));
    assert!(contents.contains("\nworkspace: /tmp/todo-md-workspace\n"));
    assert!(contents.contains("\nassignee: codex://threads/019f239d-dd6d-7451-856c-3847cadaf912\n"));
    assert!(contents.ends_with("\n\nUpdated body\n"));

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn write_ticket_cleans_titles_and_uses_untitled_fallback() {
    let dir = temp_project_dir("write-title-cleanup");

    let cleaned = write_ticket(
        &dir,
        Ticket {
            id: "clean-title".to_string(),
            title: "  Plan\r\n   work\t now  ".to_string(),
            body: "Body\n\n".to_string(),
            status: "todo".to_string(),
            order: 1000,
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
        },
    )
    .expect("write cleaned ticket");
    assert_eq!(cleaned.title, "Plan work now");
    let cleaned_contents = fs::read_to_string(&cleaned.file_path).expect("read cleaned ticket");
    assert!(cleaned_contents.contains("title: Plan work now\n"));
    assert!(cleaned_contents.ends_with("\n\nBody\n"));

    let untitled = write_ticket(
        &dir,
        Ticket {
            id: "untitled-title".to_string(),
            title: " \n\t ".to_string(),
            body: String::new(),
            status: "todo".to_string(),
            order: 2000,
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
        },
    )
    .expect("write untitled ticket");
    assert_eq!(untitled.title, "Untitled ticket");
    assert!(fs::read_to_string(&untitled.file_path)
        .expect("read untitled ticket")
        .contains("title: Untitled ticket\n"));

    fs::remove_dir_all(dir).expect("cleanup");
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
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
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
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
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
fn unrelated_nonempty_tasks_directory_does_not_replace_root_ticket_storage() {
    let dir = temp_project_dir("unrelated-tasks-storage");
    let tasks_dir = dir.join(TASKS_DIR);
    fs::create_dir_all(&tasks_dir).expect("create tasks dir");
    fs::write(tasks_dir.join("notes.txt"), "not ticket storage").expect("write tasks note");
    fs::write(
        dir.join("legacy-ticket.md"),
        "---\nid: legacy-ticket\ntitle: Legacy ticket\nstatus: todo\n---\n\nBody",
    )
    .expect("write root ticket");

    let tickets = list_tickets_from_disk(&dir).expect("list root tickets");
    assert_eq!(tickets.len(), 1);
    assert_eq!(tickets[0].id, "legacy-ticket");
    assert_eq!(
        tickets[0].file_path,
        dir.join("legacy-ticket.md").to_string_lossy()
    );

    let written = write_ticket(
        &dir,
        Ticket {
            id: "new-root-ticket".to_string(),
            title: "New root ticket".to_string(),
            body: "Body".to_string(),
            status: "todo".to_string(),
            order: 2000,
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
        },
    )
    .expect("write root ticket");
    assert_eq!(
        written.file_path,
        dir.join("new-root-ticket.md").to_string_lossy()
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
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
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
fn pasted_ticket_images_accept_mime_parameters() {
    let dir = temp_project_dir("ticket-image-mime-parameters");
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
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
        },
    )
    .expect("write ticket");

    let saved = save_ticket_image_to_project(
        &dir,
        "planned-work",
        " Image/PNG ; charset=binary ",
        b"\x89PNG\r\n\x1a\npng bytes",
    )
    .expect("save pasted image");

    assert!(saved.markdown_path.ends_with(".png"));
    assert!(PathBuf::from(saved.file_path).exists());

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
fn ticket_image_markdown_paths_reject_traversal_and_nested_paths() {
    for path in [
        "../escape.png",
        "images/",
        "images/.hidden.png",
        "images/../escape.png",
        "images/nested/escape.png",
        "images\\escape.png",
        "images/escape?.png",
    ] {
        assert_eq!(
            image_file_name_from_markdown_path(path),
            Err("Invalid image path.".to_string()),
            "{path} should be rejected"
        );
    }

    assert_eq!(
        image_file_name_from_markdown_path("images/ticket-image_2.png"),
        Ok("ticket-image_2.png")
    );
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
            pr_link: None,
            branch: None,
            workspace: None,
            assignee: None,
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
fn project_records_reorder_errors_preserve_existing_order() {
    let alpha_dir = temp_project_dir("alpha-reorder-error");
    let beta_dir = temp_project_dir("beta-reorder-error");
    let gamma_dir = temp_project_dir("gamma-reorder-error");
    let mut registry = ProjectRegistry {
        projects: vec![
            project_record("alpha", "Alpha", &alpha_dir),
            project_record("beta", "Beta", &beta_dir),
            project_record("gamma", "Gamma", &gamma_dir),
        ],
        ..ProjectRegistry::default()
    };

    for (ids, expected_error) in [
        (
            vec!["alpha".to_string(), "../beta".to_string()],
            "Invalid project id.",
        ),
        (
            vec!["alpha".to_string(), "alpha".to_string()],
            "Duplicate project id.",
        ),
        (
            vec!["gamma".to_string(), "missing".to_string()],
            "Project not found.",
        ),
    ] {
        let error = reorder_project_records(&mut registry, &ids).expect_err("reject bad reorder");
        assert_eq!(error, expected_error);
        let ids = registry
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["alpha", "beta", "gamma"]);
    }

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
