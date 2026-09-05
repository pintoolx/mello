import assert from "node:assert/strict";
import { test } from "node:test";
import { taskPolling } from "../src/lib/task-polling.ts";

test("approval keeps polling a new CREATED revision until the worker runs", () => {
  assert.deepEqual(
    taskPolling(
      { status: "CREATED", updatedAt: "new" },
      { updatedAt: "old", deadline: 30000 },
      0,
      20000,
    ),
    { awaitingWorker: true, shouldPoll: true },
  );
});
test("retry waits for an old terminal revision but stops on a new result", () => {
  const pending = { updatedAt: "old", deadline: 30000 };
  assert.deepEqual(
    taskPolling(
      { status: "ACTION_REQUIRED", updatedAt: "old" },
      pending,
      0,
      1000,
    ),
    { awaitingWorker: true, shouldPoll: true },
  );
  assert.deepEqual(
    taskPolling({ status: "COMPLETED", updatedAt: "new" }, pending, 0, 1000),
    { awaitingWorker: false, shouldPoll: false },
  );
});
test("restored CREATED tasks get a bounded polling window; in-progress tasks keep polling", () => {
  assert.equal(
    taskPolling({ status: "CREATED" }, null, 0, 1000).shouldPoll,
    true,
  );
  assert.equal(
    taskPolling({ status: "CREATED" }, null, 0, 16000).shouldPoll,
    false,
  );
  assert.equal(
    taskPolling({ status: "PAYING" }, null, 0, 60000).shouldPoll,
    true,
  );
  assert.deepEqual(
    taskPolling(
      { status: "ACTION_REQUIRED", updatedAt: "old" },
      { updatedAt: "old", deadline: 30000 },
      0,
      31000,
    ),
    { awaitingWorker: false, shouldPoll: false },
  );
});
