export type BackdropDismissState = {
  pointerStartedOnBackdrop: boolean;
};

export function createBackdropDismissState(): BackdropDismissState {
  return {
    pointerStartedOnBackdrop: false
  };
}

export function recordBackdropPointerDown(
  state: BackdropDismissState,
  target: EventTarget | null,
  backdrop: EventTarget | null
) {
  state.pointerStartedOnBackdrop = target === backdrop;
}

export function shouldDismissEditorOnBackdropPointerUp(
  state: BackdropDismissState,
  target: EventTarget | null,
  backdrop: EventTarget | null
) {
  const shouldDismiss = state.pointerStartedOnBackdrop && target === backdrop;
  resetBackdropDismissState(state);
  return shouldDismiss;
}

export function resetBackdropDismissState(state: BackdropDismissState) {
  state.pointerStartedOnBackdrop = false;
}
