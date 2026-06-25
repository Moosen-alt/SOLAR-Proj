export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function asJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// Coerce an unknown SQLite cell (or any value) to a string: strings pass through,
// null/undefined become "", everything else is String()-ified. Shared by the
// repository row mappers and the domain modules (previously copy-pasted as `text`/`s`).
export function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

// Coerce an unknown SQLite cell to a boolean (SQLite stores booleans as 0/1, and
// some rows carry the string "1"). Shared by the repository/knowledge-base mappers.
export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

