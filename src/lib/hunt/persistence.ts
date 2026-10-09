export function isValidPersistedHuntState(raw: string | null): boolean {
  if (raw === null) return true;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return false;
    const envelope = value as { state?: unknown; version?: unknown };
    if (envelope.version !== undefined && envelope.version !== 0) return false;
    const state = envelope.state;
    if (!state || typeof state !== "object") return false;
    const saved = state as { waypoints?: unknown; tracks?: unknown };
    return Array.isArray(saved.waypoints) && Array.isArray(saved.tracks);
  } catch {
    return false;
  }
}
