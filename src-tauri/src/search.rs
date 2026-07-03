use std::{cmp::Reverse, path::Path};

use crate::{
    models::{Ticket, TicketSearchMatch, TicketSearchResult, TicketSearchSegment},
    text::normalize_newlines,
    tickets::list_tickets_from_disk,
};

const MAX_QUERY_CHARS: usize = 200;
const MAX_MATCHES_PER_TICKET: usize = 5;
const BODY_SNIPPET_BEFORE_CHARS: usize = 48;
const BODY_SNIPPET_AFTER_CHARS: usize = 96;
const LONG_FIELD_CHARS: usize = 80;

pub(crate) fn search_tickets_from_disk(
    project_dir: &Path,
    query: &str,
) -> Result<Vec<TicketSearchResult>, String> {
    let tickets = list_tickets_from_disk(project_dir)?;

    Ok(search_tickets(tickets, query))
}

pub(crate) fn search_tickets(tickets: Vec<Ticket>, query: &str) -> Vec<TicketSearchResult> {
    let Some(query) = SearchQuery::new(query) else {
        return Vec::new();
    };

    let min_updated_at = tickets
        .iter()
        .map(|ticket| ticket.updated_at)
        .min()
        .unwrap_or(0);
    let max_updated_at = tickets
        .iter()
        .map(|ticket| ticket.updated_at)
        .max()
        .unwrap_or(0);

    let mut results = tickets
        .iter()
        .enumerate()
        .filter_map(|(index, ticket)| {
            evaluate_ticket(ticket, &query, min_updated_at, max_updated_at)
                .map(|result| (index, result))
        })
        .collect::<Vec<_>>();

    results.sort_by(|(left_index, left), (right_index, right)| {
        right
            .score
            .cmp(&left.score)
            .then(right.ticket.updated_at.cmp(&left.ticket.updated_at))
            .then(left_index.cmp(right_index))
    });

    results.into_iter().map(|(_, result)| result).collect()
}

pub(crate) fn markdown_to_plain_text(markdown: &str) -> String {
    let normalized = normalize_newlines(markdown);
    let mut in_fence = false;
    let mut parts = Vec::new();

    for raw_line in normalized.lines() {
        let trimmed = raw_line.trim();

        if is_fence_delimiter(trimmed) {
            in_fence = !in_fence;
            continue;
        }

        let line = if in_fence {
            raw_line.trim().to_string()
        } else {
            strip_line_markers(raw_line)
        };
        let line = transform_inline_markdown(&line);

        if !line.trim().is_empty() {
            parts.push(line);
        }
    }

    collapse_whitespace(&parts.join(" "))
}

#[derive(Debug)]
struct SearchQuery {
    phrase: String,
    tokens: Vec<String>,
}

impl SearchQuery {
    fn new(query: &str) -> Option<Self> {
        let capped = query.chars().take(MAX_QUERY_CHARS).collect::<String>();
        let normalized = normalize_for_search(&capped);
        let tokens = tokenize_normalized(&normalized);

        if tokens.is_empty() {
            return None;
        }

        Some(Self {
            phrase: tokens.join(" "),
            tokens,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchField {
    Title,
    Body,
    Status,
    Priority,
    Size,
    PrLink,
    Assignee,
    Id,
    FilePath,
    Rank,
    CreatedAt,
    UpdatedAt,
}

impl SearchField {
    fn name(self) -> &'static str {
        match self {
            SearchField::Title => "title",
            SearchField::Body => "body",
            SearchField::Status => "status",
            SearchField::Priority => "priority",
            SearchField::Size => "size",
            SearchField::PrLink => "prLink",
            SearchField::Assignee => "assignee",
            SearchField::Id => "id",
            SearchField::FilePath => "filePath",
            SearchField::Rank => "rank",
            SearchField::CreatedAt => "createdAt",
            SearchField::UpdatedAt => "updatedAt",
        }
    }

    fn phrase_score(self) -> i64 {
        match self {
            SearchField::Title => 900,
            SearchField::Status
            | SearchField::Priority
            | SearchField::Size
            | SearchField::PrLink
            | SearchField::Assignee
            | SearchField::Id
            | SearchField::FilePath => 170,
            SearchField::Body => 130,
            SearchField::Rank | SearchField::CreatedAt | SearchField::UpdatedAt => 18,
        }
    }

    fn token_score(self) -> i64 {
        match self {
            SearchField::Title => 300,
            SearchField::Status
            | SearchField::Priority
            | SearchField::Size
            | SearchField::PrLink
            | SearchField::Assignee
            | SearchField::Id
            | SearchField::FilePath => 180,
            SearchField::Body => 80,
            SearchField::Rank | SearchField::CreatedAt | SearchField::UpdatedAt => 15,
        }
    }

    fn fuzzy_score(self) -> i64 {
        match self {
            SearchField::Title => 45,
            SearchField::Status
            | SearchField::Priority
            | SearchField::Size
            | SearchField::PrLink
            | SearchField::Assignee
            | SearchField::Id
            | SearchField::FilePath => 35,
            SearchField::Body => 28,
            SearchField::Rank | SearchField::CreatedAt | SearchField::UpdatedAt => 4,
        }
    }
}

#[derive(Debug)]
struct SearchableField {
    field: SearchField,
    text: String,
    normalized: String,
    tokens: Vec<String>,
}

impl SearchableField {
    fn new(field: SearchField, text: String) -> Self {
        let normalized = normalize_for_search(&text);
        let tokens = tokenize_normalized(&normalized);

        Self {
            field,
            text,
            normalized,
            tokens,
        }
    }
}

#[derive(Debug)]
struct FieldAnalysis {
    field: SearchField,
    score: i64,
    matched_tokens: Vec<usize>,
    text: String,
}

fn evaluate_ticket(
    ticket: &Ticket,
    query: &SearchQuery,
    min_updated_at: u128,
    max_updated_at: u128,
) -> Option<TicketSearchResult> {
    let fields = searchable_fields(ticket);
    let mut matched_tokens = vec![false; query.tokens.len()];
    let mut analyses = Vec::new();
    let mut score = 0;

    for field in &fields {
        let analysis = analyze_field(field, query);

        if analysis.matched_tokens.is_empty() {
            continue;
        }

        for token_index in &analysis.matched_tokens {
            matched_tokens[*token_index] = true;
        }

        score += analysis.score;
        analyses.push(analysis);
    }

    if !matched_tokens.into_iter().all(|matched| matched) {
        return None;
    }

    score += freshness_score(ticket.updated_at, min_updated_at, max_updated_at);

    analyses.sort_by_key(|analysis| Reverse(analysis.score));
    let matches = analyses
        .into_iter()
        .take(MAX_MATCHES_PER_TICKET)
        .map(|analysis| search_match_from_analysis(analysis, query))
        .collect::<Vec<_>>();

    Some(TicketSearchResult {
        ticket: ticket.clone(),
        score,
        matches,
    })
}

fn searchable_fields(ticket: &Ticket) -> Vec<SearchableField> {
    let mut fields = vec![
        SearchableField::new(SearchField::Title, ticket.title.clone()),
        SearchableField::new(SearchField::Body, markdown_to_plain_text(&ticket.body)),
        SearchableField::new(SearchField::Status, ticket.status.clone()),
        SearchableField::new(SearchField::Id, ticket.id.clone()),
        SearchableField::new(SearchField::FilePath, ticket.file_path.clone()),
        SearchableField::new(SearchField::Rank, ticket.rank.clone()),
        SearchableField::new(
            SearchField::CreatedAt,
            timestamp_search_text(ticket.created_at),
        ),
        SearchableField::new(
            SearchField::UpdatedAt,
            timestamp_search_text(ticket.updated_at),
        ),
    ];

    if let Some(priority) = &ticket.priority {
        fields.push(SearchableField::new(
            SearchField::Priority,
            priority.clone(),
        ));
    }

    if let Some(size) = &ticket.size {
        fields.push(SearchableField::new(SearchField::Size, size.clone()));
    }

    if let Some(pr_link) = &ticket.pr_link {
        fields.push(SearchableField::new(SearchField::PrLink, pr_link.clone()));
    }

    if let Some(assignee) = &ticket.assignee {
        fields.push(SearchableField::new(
            SearchField::Assignee,
            assignee.clone(),
        ));
    }

    fields
}

fn analyze_field(field: &SearchableField, query: &SearchQuery) -> FieldAnalysis {
    let phrase_matched = field.normalized.contains(&query.phrase);
    let mut score = if phrase_matched {
        field.field.phrase_score()
    } else {
        0
    };
    let mut matched_tokens = Vec::new();

    for (token_index, token) in query.tokens.iter().enumerate() {
        if field.normalized.contains(token) {
            matched_tokens.push(token_index);
            score += field.field.token_score();
            continue;
        }

        if fuzzy_token_matches(token, &field.tokens) {
            matched_tokens.push(token_index);
            score += field.field.fuzzy_score();
        }
    }

    FieldAnalysis {
        field: field.field,
        score,
        matched_tokens,
        text: field.text.clone(),
    }
}

fn search_match_from_analysis(analysis: FieldAnalysis, query: &SearchQuery) -> TicketSearchMatch {
    let use_snippet = search_field_uses_snippet(analysis.field, &analysis.text);

    if use_snippet {
        TicketSearchMatch {
            field: analysis.field.name().to_string(),
            segments: Vec::new(),
            snippet_segments: snippet_segments(&analysis.text, &query.tokens),
        }
    } else {
        TicketSearchMatch {
            field: analysis.field.name().to_string(),
            segments: segments_for_text(&analysis.text, &query.tokens),
            snippet_segments: Vec::new(),
        }
    }
}

fn search_field_uses_snippet(field: SearchField, text: &str) -> bool {
    match field {
        SearchField::Body => true,
        SearchField::Title | SearchField::Status | SearchField::Priority | SearchField::Size => {
            false
        }
        SearchField::PrLink
        | SearchField::Assignee
        | SearchField::Id
        | SearchField::FilePath
        | SearchField::Rank
        | SearchField::CreatedAt
        | SearchField::UpdatedAt => text.chars().count() > LONG_FIELD_CHARS,
    }
}

fn freshness_score(updated_at: u128, min_updated_at: u128, max_updated_at: u128) -> i64 {
    if max_updated_at <= min_updated_at {
        return 0;
    }

    (((updated_at.saturating_sub(min_updated_at)) * 10) / (max_updated_at - min_updated_at)) as i64
}

fn timestamp_search_text(millis: u128) -> String {
    format!("{millis} {}", iso_like_utc_timestamp(millis))
}

fn iso_like_utc_timestamp(millis: u128) -> String {
    let capped_millis = millis.min(i64::MAX as u128);
    let total_seconds = (capped_millis / 1000) as i64;
    let days = total_seconds / 86_400;
    let seconds_of_day = total_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, u32, u32) {
    let days = days_since_unix_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };

    (year, month as u32, day as u32)
}

fn snippet_segments(text: &str, query_tokens: &[String]) -> Vec<TicketSearchSegment> {
    let ranges = matched_ranges(text, query_tokens);
    let (snippet_start, snippet_end) = snippet_bounds(text, ranges.first().copied());
    let mut snippet = String::new();

    if snippet_start > 0 {
        snippet.push_str("...");
    }

    snippet.push_str(&text[snippet_start..snippet_end]);

    if snippet_end < text.len() {
        snippet.push_str("...");
    }

    segments_for_text(&snippet, query_tokens)
}

fn snippet_bounds(text: &str, range: Option<(usize, usize)>) -> (usize, usize) {
    if text.is_empty() {
        return (0, 0);
    }

    let boundaries = char_boundaries(text);
    let char_count = boundaries.len().saturating_sub(1);
    let (match_start, match_end) = range.unwrap_or((0, 0));
    let match_start_char = char_index_for_byte(&boundaries, match_start);
    let match_end_char = char_index_for_byte(&boundaries, match_end);
    let start_char = match_start_char.saturating_sub(BODY_SNIPPET_BEFORE_CHARS);
    let end_char = (match_end_char + BODY_SNIPPET_AFTER_CHARS).min(char_count);

    (boundaries[start_char], boundaries[end_char])
}

fn char_boundaries(text: &str) -> Vec<usize> {
    let mut boundaries = text
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    boundaries.push(text.len());
    boundaries
}

fn char_index_for_byte(boundaries: &[usize], byte_index: usize) -> usize {
    match boundaries.binary_search(&byte_index) {
        Ok(index) => index,
        Err(index) => index.saturating_sub(1),
    }
}

fn segments_for_text(text: &str, query_tokens: &[String]) -> Vec<TicketSearchSegment> {
    if text.is_empty() {
        return Vec::new();
    }

    let ranges = matched_ranges(text, query_tokens);

    if ranges.is_empty() {
        return vec![TicketSearchSegment {
            text: text.to_string(),
            matched: false,
        }];
    }

    let mut segments = Vec::new();
    let mut cursor = 0;

    for (start, end) in ranges {
        if cursor < start {
            segments.push(TicketSearchSegment {
                text: text[cursor..start].to_string(),
                matched: false,
            });
        }

        segments.push(TicketSearchSegment {
            text: text[start..end].to_string(),
            matched: true,
        });
        cursor = end;
    }

    if cursor < text.len() {
        segments.push(TicketSearchSegment {
            text: text[cursor..].to_string(),
            matched: false,
        });
    }

    segments
}

fn matched_ranges(text: &str, query_tokens: &[String]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let lower = lowercase_with_mapping(text);

    for token in query_tokens {
        let mut token_had_exact_match = false;
        let mut search_start = 0;

        while search_start < lower.text.len() {
            let Some(relative_start) = lower.text[search_start..].find(token) else {
                break;
            };
            let normalized_start = search_start + relative_start;
            let normalized_end = normalized_start + token.len();

            if let Some(range) = lower.original_range(normalized_start, normalized_end) {
                ranges.push(range);
                token_had_exact_match = true;
            }

            search_start = normalized_end;
        }

        if !token_had_exact_match {
            ranges.extend(fuzzy_ranges(text, token));
        }
    }

    merge_ranges(ranges)
}

#[derive(Debug)]
struct LowercaseMapping {
    text: String,
    byte_to_original: Vec<(usize, usize)>,
}

impl LowercaseMapping {
    fn original_range(
        &self,
        normalized_start: usize,
        normalized_end: usize,
    ) -> Option<(usize, usize)> {
        if normalized_start >= normalized_end || normalized_end > self.byte_to_original.len() {
            return None;
        }

        let start = self.byte_to_original[normalized_start].0;
        let end = self.byte_to_original[normalized_end - 1].1;

        Some((start, end))
    }
}

fn lowercase_with_mapping(text: &str) -> LowercaseMapping {
    let mut normalized = String::new();
    let mut byte_to_original = Vec::new();

    for (start, ch) in text.char_indices() {
        let end = start + ch.len_utf8();

        for lower_ch in ch.to_lowercase() {
            let mut buffer = [0; 4];
            let lower = lower_ch.encode_utf8(&mut buffer);
            normalized.push(lower_ch);
            byte_to_original.extend(std::iter::repeat((start, end)).take(lower.len()));
        }
    }

    LowercaseMapping {
        text: normalized,
        byte_to_original,
    }
}

fn fuzzy_ranges(text: &str, query_token: &str) -> Vec<(usize, usize)> {
    let Some(threshold) = fuzzy_threshold(query_token) else {
        return Vec::new();
    };

    display_tokens(text)
        .into_iter()
        .filter(|token| bounded_edit_distance(query_token, &token.normalized, threshold).is_some())
        .map(|token| (token.start, token.end))
        .collect()
}

fn merge_ranges(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.retain(|(start, end)| start < end);
    ranges.sort_unstable();

    let mut merged: Vec<(usize, usize)> = Vec::new();

    for (start, end) in ranges {
        if let Some((_, last_end)) = merged.last_mut() {
            if start <= *last_end {
                *last_end = (*last_end).max(end);
                continue;
            }
        }

        merged.push((start, end));
    }

    merged
}

fn fuzzy_token_matches(query_token: &str, field_tokens: &[String]) -> bool {
    let Some(threshold) = fuzzy_threshold(query_token) else {
        return false;
    };

    field_tokens
        .iter()
        .any(|field_token| bounded_edit_distance(query_token, field_token, threshold).is_some())
}

fn fuzzy_threshold(token: &str) -> Option<usize> {
    match token.chars().count() {
        0..=3 => None,
        4..=7 => Some(1),
        _ => Some(2),
    }
}

fn bounded_edit_distance(left: &str, right: &str, max_distance: usize) -> Option<usize> {
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();

    if left.len().abs_diff(right.len()) > max_distance {
        return None;
    }

    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0; right.len() + 1];

    for (left_index, left_ch) in left.iter().enumerate() {
        current[0] = left_index + 1;
        let mut row_min = current[0];

        for (right_index, right_ch) in right.iter().enumerate() {
            let substitution_cost = usize::from(left_ch != right_ch);
            current[right_index + 1] = (previous[right_index + 1] + 1)
                .min(current[right_index] + 1)
                .min(previous[right_index] + substitution_cost);
            row_min = row_min.min(current[right_index + 1]);
        }

        if row_min > max_distance {
            return None;
        }

        std::mem::swap(&mut previous, &mut current);
    }

    let distance = previous[right.len()];

    (distance <= max_distance).then_some(distance)
}

#[derive(Debug)]
struct DisplayToken {
    normalized: String,
    start: usize,
    end: usize,
}

fn display_tokens(text: &str) -> Vec<DisplayToken> {
    let mut tokens = Vec::new();
    let mut token_start = None;

    for (index, ch) in text.char_indices() {
        if ch.is_whitespace() {
            if let Some(start) = token_start.take() {
                push_display_token(text, start, index, &mut tokens);
            }
        } else if token_start.is_none() {
            token_start = Some(index);
        }
    }

    if let Some(start) = token_start {
        push_display_token(text, start, text.len(), &mut tokens);
    }

    tokens
}

fn push_display_token(text: &str, start: usize, end: usize, tokens: &mut Vec<DisplayToken>) {
    let Some((start, end)) = trim_edge_punctuation_range(text, start, end) else {
        return;
    };
    let normalized = normalize_for_search(&text[start..end]);
    let Some(normalized) = clean_token(&normalized) else {
        return;
    };

    tokens.push(DisplayToken {
        normalized,
        start,
        end,
    });
}

fn normalize_for_search(value: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_space = true;

    for ch in value.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                normalized.push(' ');
                last_was_space = true;
            }
            continue;
        }

        for lower_ch in ch.to_lowercase() {
            normalized.push(lower_ch);
        }
        last_was_space = false;
    }

    normalized.trim().to_string()
}

fn tokenize_normalized(normalized: &str) -> Vec<String> {
    normalized
        .split_whitespace()
        .filter_map(clean_token)
        .collect()
}

fn clean_token(token: &str) -> Option<String> {
    let start = token
        .char_indices()
        .find(|(_, ch)| !is_edge_punctuation(*ch))
        .map(|(index, _)| index)?;
    let end = token
        .char_indices()
        .rev()
        .find(|(_, ch)| !is_edge_punctuation(*ch))
        .map(|(index, ch)| index + ch.len_utf8())?;

    (start < end).then(|| token[start..end].to_string())
}

fn trim_edge_punctuation_range(text: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    let slice = &text[start..end];
    let relative_start = slice
        .char_indices()
        .find(|(_, ch)| !is_edge_punctuation(*ch))
        .map(|(index, _)| index)?;
    let relative_end = slice
        .char_indices()
        .rev()
        .find(|(_, ch)| !is_edge_punctuation(*ch))
        .map(|(index, ch)| index + ch.len_utf8())?;

    (relative_start < relative_end).then_some((start + relative_start, start + relative_end))
}

fn is_edge_punctuation(ch: char) -> bool {
    !ch.is_alphanumeric()
}

fn is_fence_delimiter(line: &str) -> bool {
    line.starts_with("```") || line.starts_with("~~~")
}

fn strip_line_markers(line: &str) -> String {
    let mut text = line.trim();

    while let Some(rest) = text.strip_prefix('>') {
        text = rest.trim_start();
    }

    if let Some(stripped) = strip_heading_marker(text) {
        text = stripped;
    }

    let (without_list_marker, had_list_marker) = strip_list_marker(text);
    let checkbox_source = if had_list_marker {
        without_list_marker
    } else {
        text
    };

    if let Some((state, rest)) = strip_checkbox_marker(checkbox_source) {
        return format!("{state} {}", rest.trim_start());
    }

    if had_list_marker {
        without_list_marker.to_string()
    } else {
        text.to_string()
    }
}

fn strip_heading_marker(text: &str) -> Option<&str> {
    let hash_count = text.chars().take_while(|ch| *ch == '#').count();

    if hash_count == 0 || hash_count > 6 {
        return None;
    }

    let rest = &text[hash_count..];

    rest.chars()
        .next()
        .is_some_and(char::is_whitespace)
        .then(|| rest.trim_start())
}

fn strip_list_marker(text: &str) -> (&str, bool) {
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = text.strip_prefix(marker) {
            return (rest.trim_start(), true);
        }
    }

    let Some(marker_end) = ordered_list_marker_end(text) else {
        return (text, false);
    };

    (text[marker_end..].trim_start(), true)
}

fn ordered_list_marker_end(text: &str) -> Option<usize> {
    let mut saw_digit = false;

    for (index, ch) in text.char_indices() {
        if ch.is_ascii_digit() {
            saw_digit = true;
            continue;
        }

        if saw_digit && matches!(ch, '.' | ')') {
            let marker_end = index + ch.len_utf8();
            return text[marker_end..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
                .then_some(marker_end);
        }

        return None;
    }

    None
}

fn strip_checkbox_marker(text: &str) -> Option<(&'static str, &str)> {
    if let Some(rest) = text.strip_prefix("[ ]") {
        return Some(("unchecked", rest));
    }

    text.strip_prefix("[x]")
        .map(|rest| ("checked", rest))
        .or_else(|| text.strip_prefix("[X]").map(|rest| ("checked", rest)))
}

fn transform_inline_markdown(line: &str) -> String {
    let mut output = String::new();
    let mut index = 0;

    while index < line.len() {
        let rest = &line[index..];

        if let Some((consumed, replacement)) = parse_markdown_link(rest, true) {
            output.push_str(&replacement);
            index += consumed;
            continue;
        }

        if let Some((consumed, replacement)) = parse_markdown_link(rest, false) {
            output.push_str(&replacement);
            index += consumed;
            continue;
        }

        if let Some(code_rest) = rest.strip_prefix('`') {
            if let Some(end) = code_rest.find('`') {
                output.push_str(&code_rest[..end]);
                index += end + 2;
                continue;
            }

            index += 1;
            continue;
        }

        let ch = rest.chars().next().expect("non-empty rest");

        if matches!(ch, '*' | '_' | '~') {
            index += ch.len_utf8();
            continue;
        }

        output.push(ch);
        index += ch.len_utf8();
    }

    collapse_whitespace(&output)
}

fn parse_markdown_link(rest: &str, image: bool) -> Option<(usize, String)> {
    let label_start = if image {
        rest.strip_prefix("![")?;
        2
    } else {
        rest.strip_prefix('[')?;
        1
    };
    let label_end = rest[label_start..].find(']')? + label_start;
    let target_start = label_end + 1;
    let target_rest = rest[target_start..].strip_prefix('(')?;
    let target_end = target_start + 1 + target_rest.find(')')?;
    let label = rest[label_start..label_end].trim();
    let target = rest[target_start + 1..target_end].trim();
    let replacement = collapse_whitespace(&format!("{label} {target}"));

    Some((target_end + 1, replacement))
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
