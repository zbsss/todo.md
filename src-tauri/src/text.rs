use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn clean_title(title: &str) -> String {
    title
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn infer_title(body: &str, fallback: &str) -> String {
    body.lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(clean_title))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| title_from_slug(fallback))
}

pub(crate) fn title_from_slug(slug: &str) -> String {
    let title = slug
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if title.is_empty() {
        "Untitled".to_string()
    } else {
        title
    }
}

pub(crate) fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if ch.is_whitespace() || matches!(ch, '-' | '_' | '.') {
            Some('-')
        } else {
            None
        };

        if let Some(ch) = next {
            if ch == '-' {
                if !last_was_dash && !slug.is_empty() {
                    slug.push(ch);
                }
                last_was_dash = true;
            } else {
                slug.push(ch);
                last_was_dash = false;
            }
        }
    }

    let slug = slug.trim_matches('-').to_string();

    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

pub(crate) fn safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

pub(crate) fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}
