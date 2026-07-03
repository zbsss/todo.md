import type { Status } from "../app/types";

export function canQuickAddTicket(status: Status) {
  return status === "draft";
}
