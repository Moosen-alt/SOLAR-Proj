import type { AppDb } from "./db";

// WHAT AN ORG BOUGHT.
//
// This replaces the single `orgs.edition` string, which could say 'full' or
// 'review_gate' and nothing in between — it could not express "bought the form
// filler and the permit reviewer but not the autopilot", which is exactly what a
// solar company wanting one tool looks like.
//
// This registry is also the SINGLE SOURCE OF TRUTH for two allowlists that used to
// be maintained by hand in separate places and had to agree:
//   • requireAuth's API-key prefixes  (mismatch → 401)
//   • the edition deny-gate's prefixes (mismatch → 403)
// Both are now derived from PRODUCTS, so adding a product cannot desync them.

export interface ProductDef {
  key: string;
  label: string;
  /**
   * API path prefixes this product unlocks. `wildcard` products unlock everything —
   * that is the autopilot, which historically WAS the whole product, and keeping it
   * a wildcard reproduces the old 'full' edition behavior exactly.
   */
  apiPrefixes: string[];
  wildcard?: boolean;
  /** May an org API key (x-api-key, no session) reach this product's routes? */
  apiKeyAuth?: boolean;
}

export const PRODUCTS: ProductDef[] = [
  {
    key: "autopilot",
    label: "Permit + NEM autopilot (full service)",
    apiPrefixes: [],
    wildcard: true,
    // Never key-authenticated: these routes stage real filings and read portal
    // credentials, so they require a human session whose identity lands in the
    // audit trail.
    apiKeyAuth: false,
  },
  {
    key: "permit_reviewer",
    label: "Permit reviewer (plan review gate)",
    apiPrefixes: ["/api/review", "/api/code-profiles"],
    apiKeyAuth: true,
  },
  {
    key: "form_filler",
    label: "Form filler",
    // Stateless: uploads a form, returns a filled PDF, holds no tenant data at rest.
    apiPrefixes: ["/api/tools/form-fill"],
    apiKeyAuth: true,
  },
];

export const PRODUCT_KEYS = PRODUCTS.map((p) => p.key);

/** Paths every caller reaches regardless of entitlements: auth, tokenized public
 *  links, and health. Tokens ARE the authorization on the public ones. */
export const ALWAYS_OPEN_API_PREFIXES = ["/api/auth/", "/api/public/", "/health"];

/** Prefixes an org API key may authenticate, derived from the registry. */
export function apiKeyAuthPrefixes(): string[] {
  return PRODUCTS.filter((p) => p.apiKeyAuth && !p.wildcard).flatMap((p) => p.apiPrefixes);
}

/** The products an org holds. Unknown org → empty set (fails closed). */
export function orgEntitlements(db: AppDb, orgId: string): Set<string> {
  if (!orgId) return new Set();
  const rows = db.query<{ product: unknown }>("SELECT product FROM org_entitlements WHERE org_id = ?", [orgId]);
  return new Set(rows.map((r) => String(r.product)));
}

/** Does this set of products unlock this API path? */
export function productsAllowPath(products: Set<string>, apiPath: string): boolean {
  if (ALWAYS_OPEN_API_PREFIXES.some((p) => apiPath.startsWith(p))) return true;
  for (const product of PRODUCTS) {
    if (!products.has(product.key)) continue;
    if (product.wildcard) return true;
    if (product.apiPrefixes.some((p) => apiPath.startsWith(p))) return true;
  }
  return false;
}

export function grantProduct(db: AppDb, orgId: string, product: string): void {
  if (!PRODUCT_KEYS.includes(product)) throw new Error(`Unknown product: ${product}`);
  db.run(
    "INSERT OR IGNORE INTO org_entitlements (org_id, product, granted_at) VALUES (?, ?, ?)",
    [orgId, product, new Date().toISOString()],
  );
}

export function revokeProduct(db: AppDb, orgId: string, product: string): void {
  db.run("DELETE FROM org_entitlements WHERE org_id = ? AND product = ?", [orgId, product]);
}

/** Products implied by a legacy edition string, for seeding a newly created org. */
export function productsForEdition(edition: string): string[] {
  return edition === "review_gate" ? ["permit_reviewer"] : [...PRODUCT_KEYS];
}
