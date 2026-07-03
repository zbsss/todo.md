const taskSelectorTarget = "[data-task-selector]";

type ClosestTarget = {
  closest(selector: string): Element | null;
};

type ParentElementTarget = {
  parentElement: ClosestTarget | null;
};

export function findTaskSelectorFromTarget(target: EventTarget | null) {
  if (!target) {
    return null;
  }

  if (hasClosest(target)) {
    return target.closest(taskSelectorTarget);
  }

  if (hasParentElement(target)) {
    return target.parentElement?.closest(taskSelectorTarget) ?? null;
  }

  return null;
}

function hasClosest(target: EventTarget): target is EventTarget & ClosestTarget {
  return typeof (target as Partial<ClosestTarget>).closest === "function";
}

function hasParentElement(target: EventTarget): target is EventTarget & ParentElementTarget {
  return "parentElement" in target && target.parentElement !== null && hasClosest(target.parentElement as EventTarget);
}
