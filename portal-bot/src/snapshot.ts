import type { ProjectRecord } from "../../shared/src/types";

// Shared parser-snapshot accessors used by the hand-coded adapters.
// Fields like moduleQuantity, inverterModel etc. live in parserSnapshot, not the top-level record.

export function snap(project: ProjectRecord): Record<string, unknown> {
  return (project.parserSnapshot ?? {}) as Record<string, unknown>;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function num(v: unknown): number | null {
  const n = Number(v);
  return isNaN(n) ? null : n;
}
