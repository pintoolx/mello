import assert from "node:assert/strict";
import { test } from "node:test";
import { createResourceRefresh, resourceRefreshDelay } from "../src/lib/resource-refresh.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ active = true, path = "/settings", busy = false } = {}) {
  let enabled = active;
  let counter = 0;
  const timers = new Map();
  const calls = [];
  const results = [];
  const errors = [];
  let settled = 0;
  const reads = createResourceRefresh({
    request: (signal) => new Promise((resolve, reject) => calls.push({ signal, resolve, reject })),
    isActive: () => enabled,
    interval: (failures) => resourceRefreshDelay(path, busy, failures),
    onResult: (result) => results.push(result),
    onError: (cause) => errors.push(cause),
    onSettled: () => { settled += 1; },
    timers: {
      setTimeout: (callback, delay) => {
        const id = ++counter;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  return {
    reads, calls, results, errors, timers,
    settled: () => settled,
    activity: (value) => { enabled = value; reads.activityChanged(); },
    tick: () => {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      timers.delete(id);
      timer.callback();
    },
    delay: () => [...timers.values()][0]?.delay,
  };
}

test("ordinary reads, health checks, and busy tasks have bounded distinct intervals", () => {
  assert.equal(resourceRefreshDelay("/settings", false), 15_000);
  assert.equal(resourceRefreshDelay("/demo/health", false), 60_000);
  assert.equal(resourceRefreshDelay("/demo/health?deep=true", false), 60_000);
  assert.equal(resourceRefreshDelay("/tasks/id", true), 1_200);
  assert.deepEqual([1, 2, 3, 4, 5, 10].map((failure) => resourceRefreshDelay("/tasks/id", true, failure)),
    [5_000, 10_000, 20_000, 40_000, 80_000, 120_000]);
});

test("schedule only after each completed read; focus storms do not overlap or queue duplicate reads", async () => {
  const h = harness();
  h.reads.refresh();
  h.activity(true);
  h.activity(true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  h.calls[0].resolve({ version: 1 });
  await flush();
  assert.deepEqual(h.results, [{ version: 1 }]);
  assert.equal(h.delay(), 15_000);
  h.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
  h.reads.dispose();
});

test("successful actions coalesce into one read after an already in-flight stale read", async () => {
  const h = harness();
  h.reads.refresh();
  h.reads.refresh(true);
  h.reads.refresh(true);
  h.calls[0].resolve({ updatedAt: "before-action" });
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
  h.calls[1].resolve({ updatedAt: "after-action" });
  await flush();
  assert.deepEqual(h.results.map((result) => result.updatedAt), ["before-action", "after-action"]);
  assert.equal(h.delay(), 15_000);
  h.reads.dispose();
});

test("hidden or offline stops timers; becoming active immediately reads once", async () => {
  const h = harness({ active: false });
  h.reads.refresh();
  assert.equal(h.calls.length, 0);
  h.activity(true);
  h.calls[0].resolve(1);
  await flush();
  h.activity(false);
  assert.equal(h.timers.size, 0);
  h.reads.refresh(true);
  assert.equal(h.calls.length, 1);
  h.activity(true);
  h.activity(true);
  assert.equal(h.calls.length, 2);
  h.activity(false);
  h.calls[1].resolve(2);
  await flush();
  assert.equal(h.timers.size, 0);
  h.activity(true);
  assert.equal(h.calls.length, 3);
  h.reads.dispose();
});

test("read failures retain previous results and back off; a success resets the cadence", async () => {
  const h = harness({ busy: true });
  h.reads.refresh();
  h.calls[0].resolve({ status: "PAYING" });
  await flush();
  assert.equal(h.delay(), 1_200);
  h.tick();
  h.calls[1].reject(new Error("offline"));
  await flush();
  assert.deepEqual(h.results, [{ status: "PAYING" }]);
  assert.equal(h.delay(), 5_000);
  h.tick();
  h.calls[2].reject(new Error("still unavailable"));
  await flush();
  assert.equal(h.delay(), 10_000);
  h.tick();
  h.calls[3].resolve({ status: "PAYING" });
  await flush();
  assert.equal(h.delay(), 1_200);
  assert.equal(h.errors.length, 2);
  h.reads.dispose();
});

test("401 never retries, including queued action reads and later focus events", async () => {
  const h = harness();
  h.reads.refresh();
  h.reads.refresh(true);
  h.calls[0].reject(Object.assign(new Error("expired"), { status: 401 }));
  await flush();
  h.activity(true);
  h.reads.refresh(true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.errors[0].status, 401);
  h.reads.dispose();
});

test("unmount or path change aborts the old request and ignores late results", async () => {
  const h = harness();
  h.reads.refresh();
  h.reads.refresh(true);
  h.reads.dispose();
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[0].resolve({ stale: true });
  await flush();
  assert.deepEqual(h.results, []);
  assert.deepEqual(h.errors, []);
  assert.equal(h.settled(), 0);
  assert.equal(h.timers.size, 0);
  h.activity(true);
  assert.equal(h.calls.length, 1);
});

test("disposal clears a pending timer and ignores rejected aborted reads", async () => {
  const h = harness();
  h.reads.refresh();
  h.calls[0].resolve(1);
  await flush();
  h.reads.dispose();
  assert.equal(h.timers.size, 0);
  const pending = harness();
  pending.reads.refresh();
  pending.reads.dispose();
  pending.calls[0].reject(new Error("aborted"));
  await flush();
  assert.deepEqual(pending.errors, []);
  assert.equal(pending.settled(), 0);
});
