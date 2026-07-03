export type ClosestCapableElement = {
  closest(selectors: string): unknown;
};

export function shouldSkipSearchRenderForActiveEditor(
  hasDraft: boolean,
  activeElement: ClosestCapableElement | null
) {
  return hasDraft && activeElement !== null && activeElement.closest(".editor-panel") !== null;
}
