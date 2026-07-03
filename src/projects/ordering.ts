import type { ProjectSummary } from "../app/types";

export type ProjectInsertionPlacement = "before" | "after" | "end";

export function reorderProjectsForInsertion(
  projects: ProjectSummary[],
  projectId: string,
  targetId?: string,
  placement: ProjectInsertionPlacement = targetId ? "before" : "end"
) {
  if (projectId === targetId) {
    return projects;
  }

  const project = projects.find((candidate) => candidate.id === projectId);

  if (!project) {
    return projects;
  }

  const nextProjects = projects.filter((candidate) => candidate.id !== projectId);
  const targetIndex = targetId ? nextProjects.findIndex((candidate) => candidate.id === targetId) : -1;

  if (targetIndex < 0 || placement === "end") {
    const reordered = [...nextProjects, project];
    return projectsHaveSameOrder(projects, reordered) ? projects : reordered;
  }

  const insertionIndex = placement === "after" ? targetIndex + 1 : targetIndex;
  const reordered = [...nextProjects.slice(0, insertionIndex), project, ...nextProjects.slice(insertionIndex)];
  return projectsHaveSameOrder(projects, reordered) ? projects : reordered;
}

function projectsHaveSameOrder(current: ProjectSummary[], next: ProjectSummary[]) {
  return current.length === next.length && current.every((project, index) => project.id === next[index]?.id);
}
