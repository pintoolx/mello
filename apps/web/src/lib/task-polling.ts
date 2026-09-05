export interface PendingRevision {
  updatedAt: string;
  deadline: number;
}

export function taskPolling(
  task: { status?: string; updatedAt?: string },
  pending: PendingRevision | null,
  startedAt: number,
  now = Date.now(),
) {
  // approve resets a task to CREATED before the durable worker picks it up.
  // A changed revision at that point is not completion of the accepted action.
  const awaitingWorker =
    !!pending &&
    now < pending.deadline &&
    (task.updatedAt === pending.updatedAt || task.status === "CREATED");
  const terminal = [
    "COMPLETED",
    "REJECTED",
    "ACTION_REQUIRED",
    "FAILED",
    "WAITING_SELECTION",
  ].includes(task.status ?? "");
  const shouldPoll =
    awaitingWorker ||
    (task.status === "CREATED"
      ? now - startedAt < 15_000
      : !!task.status && !terminal);
  return { awaitingWorker, shouldPoll };
}
