const taskSelectorTargetSelector = "[data-task-selector]";

type ClosestTarget = {
  closest(selector: string): Element | null;
};

type ParentElementTarget = {
  parentElement?: ClosestTarget | null;
};

export function isInsideTaskSelectorTarget(target: EventTarget | null) {
  return Boolean(closestFromTarget(target, taskSelectorTargetSelector));
}

export function shouldCloseTaskSelectorsForPointerTarget(target: EventTarget | null) {
  return !isInsideTaskSelectorTarget(target);
}

function closestFromTarget(target: EventTarget | null, selector: string) {
  if (!target) {
    return null;
  }

  if (hasClosest(target)) {
    return target.closest(selector);
  }

  const parentElement = (target as ParentElementTarget).parentElement;

  return parentElement?.closest(selector) ?? null;
}

function hasClosest(target: EventTarget): target is EventTarget & ClosestTarget {
  return typeof (target as { closest?: unknown }).closest === "function";
}
