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
  // The per-portal kickoff answers (migration v18). Declared here because zod STRIPS every key a
  // schema does not name: until these three were listed, a POST or PUT carrying them answered
  // 201/200 and stored nothing. feeResponsibility is a plain string ON PURPOSE — its vocabulary
  // has exactly one gate, normalizeFeeResponsibility in portalCredentials.ts (400 on anything
  // else), and a second list here would be a second predicate that can drift from it.
  mfaRequired: z.boolean().optional(),
  mfaCodeDestination: z.string().max(500).optional(),
  feeResponsibility: z.string().max(40).optional(),
});

export const portalCredentialUpdateSchema = z.object({
  portalType: z.string().max(120).optional(),
  portalUrl: z.string().url("portalUrl must be a valid URL").max(1000).or(z.literal("")).optional(),
  username: z.string().max(320).optional(),
  password: z.string().max(1024).optional(),
  notes: z.string().max(2000).optional(),
  // Same three as the create schema. Optional and stripped-when-absent, which is exactly the
  // `key in payload` semantics updatePortalCredential needs: an omitted answer is kept.
  mfaRequired: z.boolean().optional(),
  mfaCodeDestination: z.string().max(500).optional(),
  feeResponsibility: z.string().max(40).optional(),
});

// scope: the frontend sends "ahj" or "utility"; "permit"/"nem" accepted as aliases.
export const autoLearnSchema = z.object({
  scope: z.enum(["ahj", "permit", "utility", "nem"]).optional(),
  portalUrl: z.string().url().max(1000).optional(),
  createdBy: z.string().max(120).optional(),
  // For AHJ portals where one address resolves to both a city and a county authority
  // (e.g. Accela / Oregon ePermitting), which permit discipline this pass files.
  permitType: z.enum(["structural", "electrical"]).optional(),
});

// --- Jurisdiction code profiles (review gate) --------------------------------
export const codeProfileResearchSchema = z.object({
  state: z.string().min(2, "state is required").max(40),
  ahj: z.string().max(160).optional().default(""),
});

const codeEditionSchema = z.object({
  code: z.string().min(1).max(24),
  edition: z.string().min(1).max(12),
  title: z.string().max(240).optional(),
  sourceUrl: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
});

export const codeProfileVerifySchema = z.object({
  state: z.string().min(2).max(40),
  ahj: z.string().max(160).optional().default(""),
  adoptedCodes: z.array(codeEditionSchema).max(16).default([]),
  amendments: z.array(z.object({
    code: z.string().min(1).max(24),
    section: z.string().max(60).optional(),
    summary: z.string().min(1).max(500),
    sourceUrl: z.string().max(500).optional(),
  })).max(30).default([]),
  designCriteria: z.object({
    groundSnowLoadPsf: z.number().finite().optional(),
    windSpeedMph: z.number().finite().optional(),
    windExposure: z.string().max(8).optional(),
    seismicDesignCategory: z.string().max(8).optional(),
    frostDepthIn: z.number().finite().optional(),
    riskCategory: z.string().max(8).optional(),
    sourceUrl: z.string().max(500).optional(),
  }).default({}),
  prescriptive: z.object({
    maxGroundSnowPsf: z.number().finite().optional(),
    // The minimum ground snow load Pg a design may use, by permit path (Oregon: ORSC 2023
    // R301.2.3.1 — 36 psf prescriptive, 25 psf non-prescriptive), and where it comes from.
    minGroundSnowPsfPrescriptive: z.number().finite().positive().max(400).optional(),
    minGroundSnowPsfEngineered: z.number().finite().positive().max(400).optional(),
    minGroundSnowCitation: z.string().max(200).optional(),
    maxPvDeadLoadPsf: z.number().finite().optional(),
    maxRafterSpacingIn: z.number().finite().optional(),
    allowedWindExposures: z.array(z.string().max(4)).max(6).optional(),
    maxExportKwWithoutStudy: z.number().finite().optional(),
    engineerStampOverKwDc: z.number().finite().optional(),
  }).default({}),
  fireSetbacks: z.array(z.object({
    id: z.string().min(1).max(60),
    description: z.string().min(1).max(500),
  })).max(20).default([]),
  citations: z.array(z.object({
    label: z.string().max(200),
    sourceUrl: z.string().min(1).max(500),
  })).max(30).default([]),
});

// --- Standalone review submissions (review gate) ------------------------------
export const reviewSubjectSchema = z.object({
  workType: z.enum(["solar_pv_residential", "reroof", "water_heater", "adu", "deck", "general"]).default("general"),
  state: z.string().min(2, "state is required").max(40),
  ahj: z.string().min(1, "ahj is required").max(160),
  utility: z.string().max(160).optional(),
  applicant: z.object({
    name: z.string().max(200).optional(),
    address: z.string().max(300).optional(),
    city: z.string().max(120).optional(),
    zip: z.string().max(20).optional(),
  }).optional(),
  system: z.object({
    sizeDcKw: z.number().finite().optional(),
    sizeAcKw: z.number().finite().optional(),
    interconnectionMethod: z.string().max(200).optional(),
  }).optional(),
  fields: z.record(z.string(), z.union([z.string().max(30000), z.number(), z.null()])).optional(),
});
