export function resourceRefreshDelay(
  path: string,
  busyTask: boolean,
  failures = 0,
) {
  const interval = busyTask ? 1_200 : path.split("?")[0] === "/demo/health" ? 60_000 : 15_000;
  if (!failures) return interval;
  return Math.min(120_000, Math.max(interval, 5_000) * 2 ** Math.min(failures - 1, 5));
}

type Timers = {
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type RefreshOptions<T> = {
  request: (signal: AbortSignal) => Promise<T>;
  onResult: (result: T) => void;
  onError: (cause: unknown) => void;
  onSettled: () => void;
  interval: (failures: number) => number;
  isActive: () => boolean;
  timers?: Timers;
};

// This scheduler only repeats its supplied read. It never repeats a mutation,
// overlaps reads, or keeps background timers alive for a hidden/offline page.
export function createResourceRefresh<T>(options: RefreshOptions<T>) {
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let timer: unknown;
  let controller: AbortController | null = null;
  let disposed = false;
  let unauthorized = false;
  let running = false;
  let queuedAfterAction = false;
  let failures = 0;

  function clearTimer() {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  }

  function refresh(afterAction = false) {
    if (disposed || unauthorized) return;
    clearTimer();
    if (!options.isActive()) return;
    if (running) {
      // A read begun before a successful action may return its old revision.
      // Queue one fresh read for that case; ordinary focus events only dedupe.
      queuedAfterAction ||= afterAction;
      return;
    }
    running = true;
    controller = new AbortController();
    void read(controller);
  }

  async function read(current: AbortController) {
    try {
      const result = await options.request(current.signal);
      if (disposed || current.signal.aborted) return;
      failures = 0;
      options.onResult(result);
    } catch (cause) {
      if (disposed || current.signal.aborted) return;
      failures += 1;
      unauthorized = typeof cause === "object" && cause !== null && "status" in cause && cause.status === 401;
      options.onError(cause);
    } finally {
      running = false;
      if (!disposed && !current.signal.aborted) {
        options.onSettled();
        if (queuedAfterAction) {
          queuedAfterAction = false;
          refresh();
        } else if (!unauthorized && options.isActive()) {
          timer = timers.setTimeout(() => {
            timer = undefined;
            refresh();
          }, options.interval(failures));
        }
      }
    }
  }

  return {
    refresh,
    activityChanged: () => {
      if (options.isActive()) refresh();
      else clearTimer();
    },
    dispose: () => {
      disposed = true;
      clearTimer();
      controller?.abort();
    },
  };
}
