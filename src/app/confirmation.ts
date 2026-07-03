export type ConfirmationDialogKind = "default" | "warning" | "danger";

export type ConfirmationDialogOptions = {
  kind?: ConfirmationDialogKind;
  confirmLabel?: string;
  cancelLabel?: string;
  icon?: string;
  confirmIcon?: string;
};

export type ConfirmationDialogConfig = {
  kind: ConfirmationDialogKind;
  confirmLabel: string;
  cancelLabel: string;
  icon: string;
  confirmIcon: string;
};

export function createAppDialogQueue() {
  let queue = Promise.resolve();

  return function enqueueAppDialog<T>(openDialog: () => Promise<T>) {
    const result = queue.then(
      () => openDialog(),
      () => openDialog()
    );

    queue = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  };
}

export function normalizeConfirmationDialogConfig(
  options: ConfirmationDialogOptions = {}
): ConfirmationDialogConfig {
  const kind = isConfirmationDialogKind(options.kind) ? options.kind : "warning";

  return {
    kind,
    confirmLabel: cleanConfirmationValue(options.confirmLabel, "Confirm"),
    cancelLabel: cleanConfirmationValue(options.cancelLabel, "Cancel"),
    icon: cleanConfirmationValue(options.icon, defaultConfirmationIcon(kind)),
    confirmIcon: cleanConfirmationValue(options.confirmIcon, defaultConfirmationButtonIcon(kind))
  };
}

export function confirmationConfirmButtonClass(kind: ConfirmationDialogKind) {
  return kind === "danger" ? "confirmation-confirm danger" : "confirmation-confirm";
}

export function normalizeTextInputDialogSubmission(value: string | null) {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isConfirmationDialogKind(value: string | undefined): value is ConfirmationDialogKind {
  return value === "default" || value === "warning" || value === "danger";
}

function cleanConfirmationValue(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function defaultConfirmationIcon(kind: ConfirmationDialogKind) {
  return kind === "danger" ? "trash-2" : "check";
}

function defaultConfirmationButtonIcon(kind: ConfirmationDialogKind) {
  return kind === "danger" ? "trash-2" : "check";
}
