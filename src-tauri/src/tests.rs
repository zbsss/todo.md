use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::{
    constants::{LEGACY_PROJECT_META_DIR, PROJECT_META_DIR, TASKS_DIR},
    explorer::{file_explorer_command, validate_external_url},
    images::{
        delete_ticket_image_from_project, image_file_name_from_markdown_path,
        save_ticket_image_to_project,
    },
    models::{ProjectDiskMeta, ProjectRecord, ProjectRegistry, Ticket, TicketPosition},
    paths::ensure_tasks_dir,
    projects::{
        forget_removed_project_path, is_removed_project_path, list_projects_from_registry,
        read_project_disk_meta, remember_removed_project_path, remove_project_record,
        reorder_project_records, write_project_disk_meta,
    },
    search::{markdown_to_plain_text, search_tickets_from_disk},
    text::now_millis,
    tickets::{
        apply_ticket_dependency, apply_ticket_positions, archive_done_tickets,
        count_markdown_files, list_tickets_from_disk, normalize_status, rank_between,
        rank_from_legacy_order, read_ticket, split_frontmatter, unique_ticket_id_from_base,
        validate_status, write_ticket,
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

fn search_test_ticket(id: &str, title: &str, body: &str) -> Ticket {
    Ticket {
        id: id.to_string(),
        title: title.to_string(),
        body: body.to_string(),
        status: "draft".to_string(),
        rank: "V".to_string(),
        created_at: 1,
        updated_at: 1,
        file_path: String::new(),
        priority: None,
        size: None,
        pr_link: None,
        assignee: None,
        parent: Vec::new(),
        subtasks: Vec::new(),
        blocks: Vec::new(),
        blocked_by: Vec::new(),
    }
}

fn search_match_fields(result: &crate::models::TicketSearchResult) -> Vec<&str> {
    result
        .matches
        .iter()
        .map(|ticket_match| ticket_match.field.as_str())
        .collect()
}

fn joined_segments(segments: &[crate::models::TicketSearchSegment]) -> String {
    segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join("")
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
fn statuses_support_agent_workflow_and_normalize_legacy_todo() {
    for status in ["draft", "ready", "doing", "review", "done"] {
        assert!(validate_status(status).is_ok());
        assert_eq!(normalize_status(status), Some(status.to_string()));
    }

    assert_eq!(normalize_status("todo"), Some("draft".to_string()));
    assert!(validate_status("todo").is_err());
    assert!(validate_status("missing").is_err());
}

#[test]
fn legacy_todo_status_reads_and_writes_as_draft() {
    let dir = temp_project_dir("legacy-todo-status");
    let ticket_path = dir.join("legacy-ticket.md");
    fs::write(
        &ticket_path,
        "---\nid: legacy-ticket\ntitle: Legacy ticket\nstatus: todo\ncreated_at: 1\nupdated_at: 1\n---\n\nBody",
    )
    .expect("write legacy todo ticket");

    let ticket = read_ticket(&dir, "legacy-ticket").expect("read legacy ticket");
    assert_eq!(ticket.status, "draft");

    write_ticket(&dir, ticket).expect("write normalized ticket");
    let contents = fs::read_to_string(ticket_path).expect("read normalized ticket");
    assert!(contents.contains("\nstatus: draft\n"));
    assert!(!contents.contains("\nstatus: todo\n"));

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn agent_metadata_is_read_and_preserved_when_tickets_are_written() {
    let dir = temp_project_dir("agent-metadata");
    let ticket_path = dir.join("agent-ticket.md");
    fs::write(
        &ticket_path,
        "---\nid: agent-ticket\ntitle: Agent task\nstatus: doing\norder: 1000\ncreated_at: 10\nupdated_at: 20\npr_link: https://github.com/zbsss/todo.md/pull/22\nbranch: codex/ai-agent-metadata\nworkspace: /tmp/todo-md-workspace\nassignee: codex://threads/019f239d-dd6d-7451-856c-3847cadaf912\npriority: p1\nsize: m\ntags: ui, metadata, UI\n---\n\nBody",
    )
    .expect("write ticket with agent metadata");

    let ticket = read_ticket(&dir, "agent-ticket").expect("read ticket");
    assert!(ticket.rank.starts_with(&rank_from_legacy_order(1000)));
    assert_eq!(
        ticket.pr_link.as_deref(),
        Some("https://github.com/zbsss/todo.md/pull/22")
    );
    assert_eq!(
        ticket.assignee.as_deref(),
        Some("codex://threads/019f239d-dd6d-7451-856c-3847cadaf912")
    );
    assert_eq!(ticket.priority.as_deref(), Some("P1"));
    assert_eq!(ticket.size.as_deref(), Some("M"));

    let updated = write_ticket(
        &dir,
        Ticket {
            body: "Updated body".to_string(),
            ..ticket
        },
    )
    .expect("write updated ticket");
    let contents = fs::read_to_string(&updated.file_path).expect("read updated ticket");

    assert!(contents.contains("\nrank: "));
    assert!(!contents.contains("\norder: "));
    assert!(contents.contains("\npr_link: https://github.com/zbsss/todo.md/pull/22\n"));
    assert!(!contents.contains("\nbranch:"));
    assert!(!contents.contains("\nworkspace:"));
    assert!(contents.contains("\nassignee: codex://threads/019f239d-dd6d-7451-856c-3847cadaf912\n"));
    assert!(contents.contains("\npriority: P1\n"));
    assert!(contents.contains("\nsize: M\n"));
    assert!(!contents.contains("\ntags:"));
    assert!(contents.ends_with("\n\nUpdated body\n"));

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn dependency_frontmatter_is_read_and_written() {
    let dir = temp_project_dir("dependency-frontmatter");
    let ticket_path = dir.join("child-ticket.md");
    fs::write(
        &ticket_path,
        "---\nid: child-ticket\ntitle: Child ticket\nstatus: ready\nrank: V\ncreated_at: 1\nupdated_at: 2\nparent: [parent-ticket, parent-ticket, child-ticket]\nsubtasks: subtask-one subtask-two\nblocks: [blocked-ticket]\nblocked_by: blocker-ticket\n---\n\nBody",
    )
    .expect("write ticket with dependency metadata");

    let ticket = read_ticket(&dir, "child-ticket").expect("read dependency ticket");

    assert_eq!(ticket.parent, vec!["parent-ticket"]);
    assert_eq!(ticket.subtasks, vec!["subtask-one", "subtask-two"]);
    assert_eq!(ticket.blocks, vec!["blocked-ticket"]);
    assert_eq!(ticket.blocked_by, vec!["blocker-ticket"]);

    let updated = write_ticket(
        &dir,
        Ticket {
            body: "Updated body".to_string(),
            ..ticket
        },
    )
    .expect("write dependency ticket");
    let contents = fs::read_to_string(&updated.file_path).expect("read written ticket");

    assert!(contents.contains("\nparent: [parent-ticket]\n"));
    assert!(contents.contains("\nsubtasks: [subtask-one, subtask-two]\n"));
    assert!(contents.contains("\nblocks: [blocked-ticket]\n"));
    assert!(contents.contains("\nblocked_by: [blocker-ticket]\n"));
    assert!(contents.ends_with("\n\nUpdated body\n"));

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn dependency_updates_are_written_to_both_tickets() {
    let dir = temp_project_dir("dependency-symmetric-update");

    for id in ["parent", "child", "blocker", "blocked"] {
        write_ticket(&dir, search_test_ticket(id, id, "Body")).expect("write ticket");
    }

    apply_ticket_dependency(&dir, "child", "parent", "parent", true).expect("link parent");

    assert_eq!(
        read_ticket(&dir, "child").expect("read child").parent,
        vec!["parent"]
    );
    assert_eq!(
        read_ticket(&dir, "parent").expect("read parent").subtasks,
        vec!["child"]
    );

    apply_ticket_dependency(&dir, "blocker", "blocked", "blocks", true).expect("link blocker");

    assert_eq!(
        read_ticket(&dir, "blocker").expect("read blocker").blocks,
        vec!["blocked"]
    );
    assert_eq!(
        read_ticket(&dir, "blocked")
            .expect("read blocked")
            .blocked_by,
        vec!["blocker"]
    );

    apply_ticket_dependency(&dir, "parent", "child", "subtask", false).expect("unlink subtask");
    apply_ticket_dependency(&dir, "blocked", "blocker", "blockedBy", false)
        .expect("unlink blocker");

    assert!(read_ticket(&dir, "child")
        .expect("read unlinked child")
        .parent
        .is_empty());
    assert!(read_ticket(&dir, "parent")
        .expect("read unlinked parent")
        .subtasks
        .is_empty());
    assert!(read_ticket(&dir, "blocker")
        .expect("read unlinked blocker")
        .blocks
        .is_empty());
    assert!(read_ticket(&dir, "blocked")
        .expect("read unlinked blocked")
        .blocked_by
        .is_empty());

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn search_matches_title_body_metadata_path_rank_and_timestamps() {
    let dir = temp_project_dir("search-field-coverage");
    let ticket = write_ticket(
        &dir,
        Ticket {
            id: "search-all-fields".to_string(),
            title: "Billing webhook outage".to_string(),
            body: "Rollback steps mention escrow reconciliation.".to_string(),
            status: "review".to_string(),
            rank: "Qz".to_string(),
            created_at: 0,
            updated_at: 1_700_000_000_000,
            file_path: String::new(),
            priority: Some("P1".to_string()),
            size: Some("XL".to_string()),
            pr_link: Some("https://github.com/zbsss/todo.md/pull/42".to_string()),
            assignee: Some("codex://threads/search-agent".to_string()),
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
        },
    )
    .expect("write searchable ticket");

    assert!(PathBuf::from(&ticket.file_path).exists());

    for (query, field) in [
        ("billing", "title"),
        ("escrow", "body"),
        ("review", "status"),
        ("P1", "priority"),
        ("XL", "size"),
        ("pull/42", "prLink"),
        ("search-agent", "assignee"),
        ("search-all-fields", "id"),
        (".md", "filePath"),
        ("Qz", "rank"),
        ("1970-01-01", "createdAt"),
        ("1700000000000", "updatedAt"),
    ] {
        let results = search_tickets_from_disk(&dir, query).expect("search tickets");

        assert_eq!(results.len(), 1, "{query} should find the ticket");
        assert_eq!(results[0].ticket.id, "search-all-fields");
        assert!(
            search_match_fields(&results[0]).contains(&field),
            "{query} should include a {field} match, got {:?}",
            search_match_fields(&results[0])
        );
    }

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn search_body_snippets_include_context_around_deep_matches() {
    let dir = temp_project_dir("search-body-snippet");
    let body = format!(
        "{}critical needle context lives here for search snippets {}",
        "intro ".repeat(40),
        "tail ".repeat(40)
    );
    write_ticket(
        &dir,
        search_test_ticket("snippet-ticket", "Snippet ticket", &body),
    )
    .expect("write snippet ticket");

    let results = search_tickets_from_disk(&dir, "needle").expect("search tickets");
    let body_match = results[0]
        .matches
        .iter()
        .find(|ticket_match| ticket_match.field == "body")
        .expect("body match");
    let snippet = joined_segments(&body_match.snippet_segments);

    assert!(snippet.contains("critical needle context"));
    assert!(snippet.starts_with("..."));
    assert!(snippet.len() < markdown_to_plain_text(&body).len());
    assert!(body_match
        .snippet_segments
        .iter()
        .any(|segment| segment.matched && segment.text == "needle"));

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn search_long_title_matches_return_highlight_segments() {
    let dir = temp_project_dir("search-long-title-highlight");
    let title = format!(
        "{} decisive longtitletoken that still needs title highlighting",
        "prefix ".repeat(15)
    );
    write_ticket(
        &dir,
        search_test_ticket("long-title-ticket", &title, "Body"),
    )
    .expect("write long-title ticket");

    let results = search_tickets_from_disk(&dir, "longtitletoken").expect("search tickets");
    let title_match = results[0]
        .matches
        .iter()
        .find(|ticket_match| ticket_match.field == "title")
        .expect("title match");

    assert!(title_match.snippet_segments.is_empty());
    assert!(title_match
        .segments
        .iter()
        .any(|segment| segment.matched && segment.text == "longtitletoken"));

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn search_fuzzy_matching_is_narrow() {
    let dir = temp_project_dir("search-fuzzy");
    write_ticket(
        &dir,
        search_test_ticket(
            "auth-ticket",
            "Authentication broker",
            "Token exchange details",
        ),
    )
    .expect("write auth ticket");

    let close = search_tickets_from_disk(&dir, "authentcation").expect("search close typo");
    assert_eq!(close.len(), 1);
    assert_eq!(close[0].ticket.id, "auth-ticket");

    let distant = search_tickets_from_disk(&dir, "zzthentzztion").expect("search distant typo");
    assert!(distant.is_empty());

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn search_multi_token_queries_require_every_token_somewhere() {
    let dir = temp_project_dir("search-and-semantics");
    write_ticket(
        &dir,
        search_test_ticket("both-ticket", "Alpha release", "Beta validation notes"),
    )
    .expect("write both ticket");
    write_ticket(
        &dir,
        search_test_ticket("alpha-ticket", "Alpha only", "No second token here"),
    )
    .expect("write alpha ticket");
    write_ticket(
        &dir,
        search_test_ticket("beta-ticket", "Other title", "Beta only"),
    )
    .expect("write beta ticket");

    let results = search_tickets_from_disk(&dir, "alpha beta").expect("search tickets");

    assert_eq!(
        results
            .iter()
            .map(|result| result.ticket.id.as_str())
            .collect::<Vec<_>>(),
        vec!["both-ticket"]
    );

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn search_ordering_prefers_title_matches_over_body_matches() {
    let dir = temp_project_dir("search-ordering");
    let mut title_ticket = search_test_ticket("title-match", "Cache invalidation", "No body hit");
    title_ticket.updated_at = 1;
    write_ticket(&dir, title_ticket).expect("write title ticket");

    let mut body_ticket = search_test_ticket(
        "body-match",
        "Background worker",
        "Cache invalidation appears in the body only",
    );
    body_ticket.updated_at = 999_999;
    write_ticket(&dir, body_ticket).expect("write body ticket");

    let results = search_tickets_from_disk(&dir, "cache").expect("search tickets");

    assert_eq!(results.len(), 2);
    assert_eq!(results[0].ticket.id, "title-match");
    assert!(results[0].score > results[1].score);

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn markdown_plain_text_extraction_keeps_readable_content() {
    let markdown = r#"
# Heading
> - [x] **Done** [label](https://example.com)
- [ ] Todo with `inline code`
![Alt text](images/foo.png)
1. Item with _emphasis_
```rust
fn main() {}
```
"#;

    let plain = markdown_to_plain_text(markdown);

    assert!(plain.contains("Heading"));
    assert!(plain.contains("checked Done label https://example.com"));
    assert!(plain.contains("unchecked Todo with inline code"));
    assert!(plain.contains("Alt text images/foo.png"));
    assert!(plain.contains("Item with emphasis"));
    assert!(plain.contains("fn main() {}"));
    assert!(!plain.contains("[x]"));
    assert!(!plain.contains("```"));
}

#[test]
fn search_segments_do_not_split_multibyte_characters() {
    let dir = temp_project_dir("search-unicode-segments");
    write_ticket(
        &dir,
        search_test_ticket("unicode-ticket", "Fix naïve café parser", "Body"),
    )
    .expect("write unicode ticket");

    let results = search_tickets_from_disk(&dir, "café").expect("search tickets");
    let title_match = results[0]
        .matches
        .iter()
        .find(|ticket_match| ticket_match.field == "title")
        .expect("title match");

    assert_eq!(
        joined_segments(&title_match.segments),
        "Fix naïve café parser"
    );
    assert_eq!(
        title_match
            .segments
            .iter()
            .filter(|segment| segment.matched)
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>(),
        vec!["café"]
    );

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn archive_done_tickets_moves_done_files_out_of_active_tasks() {
    let dir = temp_project_dir("archive-done-tickets");
    let ready_path = dir.join("ready-ticket.md");
    let done_path = dir.join("done-ticket.md");
    let archived_dir = dir.join(".tasks").join("archived");

    fs::create_dir_all(&archived_dir).expect("create archived dir");
    fs::write(
        &ready_path,
        "---\nid: ready-ticket\ntitle: Ready ticket\nstatus: ready\nrank: V\ncreated_at: 1\nupdated_at: 1\n---\n\nReady",
    )
    .expect("write ready ticket");
    fs::write(
        &done_path,
        "---\nid: done-ticket\ntitle: Done ticket\nstatus: done\nrank: V\ncreated_at: 1\nupdated_at: 1\n---\n\nDone",
    )
    .expect("write done ticket");
    fs::write(archived_dir.join("done-ticket.md"), "existing archive")
        .expect("write existing archive");

    let archived_count = archive_done_tickets(&dir).expect("archive done tickets");
    let tickets = list_tickets_from_disk(&dir).expect("list remaining tickets");

    assert_eq!(archived_count, 1);
    assert!(ready_path.exists());
    assert!(!done_path.exists());
    assert!(archived_dir.join("done-ticket.md").exists());
    assert!(archived_dir.join("done-ticket-2.md").exists());
    assert_eq!(
        tickets
            .iter()
            .map(|ticket| ticket.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ready-ticket"]
    );

    fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn legacy_duplicate_orders_get_distinct_in_memory_ranks() {
    let dir = temp_project_dir("duplicate-order-ranks");
    let no_order_path = dir.join("no-order.md");
    let first_path = dir.join("first.md");
    let second_path = dir.join("second.md");

    fs::write(
        &no_order_path,
        "---\nid: no-order\ntitle: No order\nstatus: todo\ncreated_at: 1\nupdated_at: 1\n---\n\nNo order",
    )
    .expect("write no-order legacy ticket");
    fs::write(
        &first_path,
        "---\nid: first\ntitle: A first\nstatus: todo\norder: 1000\ncreated_at: 1\nupdated_at: 1\n---\n\nFirst",
    )
    .expect("write first legacy ticket");
    fs::write(
        &second_path,
        "---\nid: second\ntitle: B second\nstatus: todo\norder: 1000\ncreated_at: 1\nupdated_at: 1\n---\n\nSecond",
    )
    .expect("write second legacy ticket");

    let tickets = list_tickets_from_disk(&dir).expect("list legacy tickets");
    assert_eq!(
        tickets
            .iter()
            .map(|ticket| ticket.id.as_str())
            .collect::<Vec<_>>(),
        vec!["no-order", "first", "second"]
    );
    assert!(tickets[0].rank < tickets[1].rank);
    assert!(tickets[1].rank < tickets[2].rank);
    assert!(!fs::read_to_string(no_order_path)
        .expect("read no-order legacy ticket")
        .contains("\nrank: "));
    assert!(!fs::read_to_string(first_path)
        .expect("read first legacy ticket")
        .contains("\nrank: "));
    assert!(!fs::read_to_string(second_path)
        .expect("read second legacy ticket")
        .contains("\nrank: "));

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
            status: "draft".to_string(),
            rank: rank_between(None, None).expect("initial rank"),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
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
            status: "draft".to_string(),
            rank: rank_between(None, None).expect("initial rank"),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
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
fn applying_ticket_positions_only_rewrites_changed_tickets() {
    let dir = temp_project_dir("rank-reorder");
    let first_rank = rank_between(None, None).expect("first rank");
    let second_rank = rank_between(Some(&first_rank), None).expect("second rank");
    let first = write_ticket(
        &dir,
        Ticket {
            id: "first".to_string(),
            title: "First".to_string(),
            body: "First body".to_string(),
            status: "draft".to_string(),
            rank: first_rank.clone(),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
        },
    )
    .expect("write first ticket");
    let second = write_ticket(
        &dir,
        Ticket {
            id: "second".to_string(),
            title: "Second".to_string(),
            body: "Second body".to_string(),
            status: "draft".to_string(),
            rank: second_rank.clone(),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
        },
    )
    .expect("write second ticket");

    let first_before = fs::read_to_string(&first.file_path).expect("read first ticket");
    let second_before = fs::read_to_string(&second.file_path).expect("read second ticket");
    apply_ticket_positions(
        &dir,
        vec![
            TicketPosition {
                id: "first".to_string(),
                status: "draft".to_string(),
                rank: first_rank.clone(),
            },
            TicketPosition {
                id: "second".to_string(),
                status: "draft".to_string(),
                rank: second_rank.clone(),
            },
        ],
    )
    .expect("apply no-op positions");

    assert_eq!(
        fs::read_to_string(&first.file_path).expect("read first ticket"),
        first_before
    );
    assert_eq!(
        fs::read_to_string(&second.file_path).expect("read second ticket"),
        second_before
    );

    let moved_rank = rank_between(Some(&first_rank), Some(&second_rank)).expect("moved rank");
    apply_ticket_positions(
        &dir,
        vec![TicketPosition {
            id: "second".to_string(),
            status: "draft".to_string(),
            rank: moved_rank.clone(),
        }],
    )
    .expect("move second ticket");

    assert_eq!(
        fs::read_to_string(&first.file_path).expect("read first ticket"),
        first_before
    );
    let second_after = fs::read_to_string(&second.file_path).expect("read second ticket");
    assert_ne!(second_after, second_before);
    assert!(second_after.contains(&format!("\nrank: {moved_rank}\n")));
    assert!(!second_after.contains("\norder: "));

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
            status: "draft".to_string(),
            rank: rank_between(None, None).expect("initial rank"),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
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
            status: "draft".to_string(),
            rank: rank_between(None, None).expect("initial rank"),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
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
            status: "draft".to_string(),
            rank: rank_between(None, None).expect("initial rank"),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
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
            status: "draft".to_string(),
            rank: rank_between(None, None).expect("initial rank"),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
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
            status: "draft".to_string(),
            rank: rank_between(None, None).expect("initial rank"),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
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
            status: "draft".to_string(),
            rank: rank_between(None, None).expect("initial rank"),
            created_at: 1,
            updated_at: 1,
            file_path: String::new(),
            priority: None,
            size: None,
            pr_link: None,
            assignee: None,
            parent: Vec::new(),
            subtasks: Vec::new(),
            blocks: Vec::new(),
            blocked_by: Vec::new(),
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
fn external_links_allow_pr_and_codex_protocols_only() {
    for url in [
        "https://github.com/zbsss/todo.md/pull/23",
        "http://github.com/zbsss/todo.md/pull/23",
        "codex://threads/019f239d-dd6d-7451-856c-3847cadaf912",
    ] {
        assert_eq!(
            validate_external_url(url),
            Ok(()),
            "{url} should be allowed"
        );
    }

    for url in [
        "file:///Users/example",
        "javascript:alert(1)",
        "https://github.com/\n",
        "codex:",
    ] {
        assert!(
            validate_external_url(url).is_err(),
            "{url} should be rejected"
        );
    }
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
