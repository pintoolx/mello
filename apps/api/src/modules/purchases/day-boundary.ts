const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1_000;

export function taipeiDayBounds(now = new Date()): { start: Date; end: Date } {
  const taipeiTime = now.getTime() + TAIPEI_OFFSET_MS;
  const shifted = new Date(taipeiTime);
  const startShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return {
    start: new Date(startShifted - TAIPEI_OFFSET_MS),
    end: new Date(startShifted + 24 * 60 * 60 * 1_000 - TAIPEI_OFFSET_MS),
  };
}
