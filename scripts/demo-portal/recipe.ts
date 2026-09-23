// ---------------------------------------------------------------------------
// THE RECIPE FOR THE FICTIONAL PORTAL — hand-written, in the shape the product stores in
// portal_recipes and close to what the recorder (portal-bot/src/recordRecipe.ts) produces,
// with one deliberate difference: the final-submit step is STRICTER than the recorder's (see
// the step itself):
//
//   · fills and selects carry a BINDING KEY (`field`), never a literal — the value is
//     resolved per project by backend/src/portalRecipes.ts resolveRecipeFieldValues, the
//     same function staging uses. The `value` on each step is a deliberately wrong
//     "learn-time" literal, so a replay that ever typed a frozen value would show it.
//   · the account number is SENSITIVE: bound by name, no value stored (hard rule 2).
//   · `note` is the control's own visible label — the replay engine's drift precheck and
//     self-heal match on it, so it is a key, not decoration.
//   · advancing clicks are noted "advance: …" (that is what triggers the engine's blank
//     sweep and per-page photograph before it leaves a page).
//   · the human's submit click is a step flagged isFinalSubmit WITH a real selector (the
//     recorder writes an empty selector + optional, so replay merely skips it), and the
//     recipe ends with the stopForReview marker — the recorder appends that marker to every
//     recipe. In guided-manual replay neither can ever produce a submit: executeClick refuses
//     an isFinalSubmit step without autoSubmit, and runAll stops at the marker.
// ---------------------------------------------------------------------------
import type { PortalRecipe, RecipeStep } from "../../shared/src/types";

export function demoPortalRecipe(baseUrl: string): PortalRecipe {
  const fill = (css: string, label: string, field: string, learnLiteral = "LEARN-TIME-VALUE"): RecipeStep => ({
    action: "fill", phase: "fill", selector: { css, fallbacks: [{ label }] }, field, value: learnLiteral, note: label,
  });
  const choose = (css: string, label: string, field: string, learnLiteral = ""): RecipeStep => ({
    action: "select", phase: "fill", selector: { css, fallbacks: [{ label }] }, field, value: learnLiteral, note: label,
  });
  const advance = (label: string): RecipeStep => ({
    action: "click", phase: "fill", selector: { role: "button", name: "Continue", exact: true }, note: `advance: ${label}`,
  });

  const steps: RecipeStep[] = [
    { action: "goto", phase: "open", value: `${baseUrl}/home`, note: "entry url" },
    { action: "click", phase: "open", selector: { role: "button", name: "Start a new application", exact: true, fallbacks: [{ css: "#startNew" }] }, note: "advance: Start a new application" },

    // Customer information
    fill("#firstName", "First name", "homeownerFirstName", "LEARN-TIME-FIRST"),
    fill("#lastName", "Last name", "homeownerLastName", "LEARN-TIME-LAST"),
    fill("#email", "Email address", "homeownerEmail", "learn-time@example.invalid"),
    fill("#phone", "Phone number", "homeownerPhone", "(000) 000-0000"),
    // Recorder shape for a secret: bound by name, NO value stored, optional.
    {
      action: "fill", phase: "fill", selector: { css: "#accountNumber", fallbacks: [{ label: "Utility account number" }] },
      field: "accountNumber", sensitive: true, optional: true,
      note: `SENSITIVE — bound to project field "accountNumber" (no value stored). Utility account number`,
    },
    advance("Continue to service address"),

    // Service address
    fill("#street", "Street address", "street", "1 Learn-Time Street"),
    fill("#city", "City name", "city", "Learntown"),
    choose("#state", "State", "state", "WA"),
    fill("#zip", "ZIP code", "zip", "00000"),
    advance("Continue to generation system"),

    // Generation system — manufacturer then its cascaded model list
    fill("#dcKw", "System size (kW DC)", "systemSizeDcKw", "0.00"),
    fill("#acKw", "System size (kW AC)", "systemSizeAcKw", "0.00"),
    choose("#moduleManufacturer", "Module manufacturer", "moduleManufacturer", "Silfab"),
    choose("#moduleModel", "Module model", "moduleModel", "SIL-400 HC+"),
    fill("#moduleCount", "Number of modules", "moduleQuantity", "1"),
    choose("#inverterModel", "Inverter model", "inverterModel", "SE7600H-US"),
    fill("#inverterCount", "Number of inverters", "inverterQuantity", "1"),
    advance("Continue to documents"),

    // Documents — attached from the project's own document set (docsByType)
    { action: "upload", phase: "upload", selector: { css: "#planSetFile" }, docType: "plan_set", note: "upload plan_set: Plan set (PDF)" },
    { action: "upload", phase: "upload", selector: { css: "#oneLineFile" }, docType: "sld", note: "upload sld: Single-line diagram" },
    advance("Continue to review"),

    // The human's submit — STRICTER than the real recorder writes it. recordRecipe.ts records a
    // blocked submit with `selector: {}` and `optional: true`, so replay skips it for want of a
    // target. This step carries a REAL selector and is not optional, so the engine must actively
    // REFUSE it — and the refusal must be the guided-manual final-submit rule (isFinalSubmit,
    // autoSubmit off), because that is what the video's captions say stopped it.
    // THE NOTE IS PART OF THE GATE'S INPUT: executeClick tests "<name> <note>" against
    // PAY_FEE_REPLAY_GATE first. The recorder's own wording ("…a submit/pay-like control…")
    // matches `\bpay\b`, so with it the FEE gate refused this step before the final-submit rule
    // was ever consulted — the first recording showed the wrong gate. Keep money words out of
    // this note; the recorder's preflight (scripts/demo-portal/gateProbe.ts) refuses to record
    // if any gate other than the final-submit rule answers.
    {
      action: "click", phase: "review", selector: { role: "button", name: "Submit application", exact: true, fallbacks: [{ css: "#submitApplication" }] },
      isFinalSubmit: true,
      note: `final submit: "Submit application" — recorded, flagged isFinalSubmit; guided-manual replay never clicks it (a person submits)`,
    },
    { action: "stopForReview", phase: "review", note: "Stop at review — human submits manually." },
  ];

  return {
    id: "demo-portal-recipe",
    scopeType: "utility",
    profileKey: "zz|demo-utility-co|fictional",
    state: "ZZ",
    ahj: "",
    utility: "Demo Utility Co",
    portalPlatform: "fictional-demo",
    portalUrl: `${baseUrl}/login`,
    status: "complete",
    version: 1,
    steps,
    createdBy: "scripts/demo-portal/recipe.ts",
    createdAt: "",
    updatedAt: "",
    notes: "Hand-written recipe for the fictional Act 4 portal. Never stored in a database.",
    discipline: "",
  };
}
