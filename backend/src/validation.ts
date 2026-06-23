// Runtime request-body validation using Zod.
// Import the schema and call .safeParse(req.body) — on failure, throw HttpError(400)
// with the first validation message so the client always gets a clear error.

import { z } from "zod";
import { HttpError } from "./httpError";

export { z };

export function validate<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues;
    const first = issues[0];
    const field = first.path.length ? first.path.join(".") : "body";
    throw new HttpError(400, `${field}: ${first.message}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const portalCredentialCreateSchema = z.object({
  portalType: z.string().max(120).optional(),
  portalUrl: z.string().url("portalUrl must be a valid URL").max(1000).or(z.literal("")).optional(),
  username: z.string().min(1, "username is required").max(320),
  password: z.string().min(1, "password is required").max(1024),
  notes: z.string().max(2000).optional(),
});

export const portalCredentialUpdateSchema = z.object({
  portalType: z.string().max(120).optional(),
  portalUrl: z.string().url("portalUrl must be a valid URL").max(1000).or(z.literal("")).optional(),
  username: z.string().max(320).optional(),
  password: z.string().max(1024).optional(),
  notes: z.string().max(2000).optional(),
});

// scope: the frontend sends "ahj" or "utility"; "permit"/"nem" accepted as aliases.
export const autoLearnSchema = z.object({
  scope: z.enum(["ahj", "permit", "utility", "nem"]).optional(),
  portalUrl: z.string().url().max(1000).optional(),
  createdBy: z.string().max(120).optional(),
});

export const knowledgeQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  projectId: z.string().optional(),
  ahj: z.string().max(200).optional(),
  utility: z.string().max(200).optional(),
});
