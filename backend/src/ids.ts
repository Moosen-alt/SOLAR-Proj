import { randomUUID } from "node:crypto";

export function id(): string {
  return randomUUID();
}

