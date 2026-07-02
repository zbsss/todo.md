use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDiskMeta {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) created_at: u128,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRegistry {
    pub(crate) projects: Vec<ProjectRecord>,
    #[serde(default)]
    pub(crate) removed_project_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) ticket_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceInfo {
    pub(crate) base_dir: String,
    pub(crate) projects: Vec<ProjectSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ticket {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) status: String,
    pub(crate) order: i64,
    pub(crate) created_at: u128,
    pub(crate) updated_at: u128,
    pub(crate) file_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pr_link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) assignee: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedTicketImage {
    pub(crate) markdown_path: String,
    pub(crate) file_path: String,
    pub(crate) alt: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TicketPosition {
    pub(crate) id: String,
    pub(crate) status: String,
    pub(crate) order: i64,
}
