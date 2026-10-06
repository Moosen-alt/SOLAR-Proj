import type { CodeEdition, NecEditionRequirements, NecEditionYear } from "../../shared/src/types";
import { codeFamilyOf } from "./codeFamilies";

// THE ADOPTED EDITION IS THE ONE A PLAN CHECKER APPLIES (issue #143).
//
// city.elec.rapid-shutdown-missing, city.elec.labels-missing and the 705 interconnection rules were
// presence checks citing "NEC 690.12" / "NEC 705.12" whatever cycle the jurisdiction is on. A
// 2014-NEC county measures rapid shutdown from a 10 ft boundary; a 2017+ one from 1 ft with a
// separate inside-the-array requirement; a 2020+ one moved supply-side connections to 705.11. A
// correction notice cites the edition's own article, so the gate has to as well.
//
// UNKNOWN BEATS WRONG. Every article below is one the table states with confidence. Where a
// subsection's number in an edition is not known for certain the cell is null, and the rule cites
// the article generically instead of printing a guessed subsection on a document a plans examiner
// reads. Fill a null only from the edition's text.
export const NEC_EDITION_REQUIREMENTS: Readonly<Record<NecEditionYear, NecEditionRequirements>> = {
  2014: {
    edition: 2014,
    rapidShutdown: {
      article: "690.12",
      limits: "controlled conductors more than 10 ft from the array or more than 5 ft inside a building limited to 30 V and 240 VA within 10 seconds of initiation",
      insideBoundaryArticle: null,
      requiresListedEquipment: false,
      noExposedWiringOption: false,
      initiationDeviceArticle: null,
    },
    labels: {
      rapidShutdown: "690.56(C)",
      rapidShutdownWording: "PHOTOVOLTAIC SYSTEM EQUIPPED WITH RAPID SHUTDOWN",
      // The 2014 disconnect-marking provision was reorganised in 2017; its 2014 number is not
      // stated here with confidence.
      disconnect: null,
      dcSource: "690.53",
      pointOfInterconnection: "690.54",
      powerSourceDirectory: "705.10",
      // Article 710 (stand-alone systems) arrives with the 2017 NEC.
      standAloneDirectory: null,
      dcConductorMarking: "690.31(G)(3)",
    },
    interconnection: { supplySide: "705.12(A)", loadSide: "705.12(D)", busbar120: "705.12(D)(2)(3)(b)" },
  },
  2017: {
    edition: 2017,
    rapidShutdown: {
      article: "690.12",
      limits: "outside the array boundary (1 ft from the array) controlled conductors limited to 30 V within 30 seconds; inside the boundary a listed PV hazard control system, 80 V within 30 seconds, or no exposed wiring",
      insideBoundaryArticle: "690.12(B)(2)",
      requiresListedEquipment: true,
      noExposedWiringOption: true,
      // One- and two-family dwellings: the initiation device at a readily accessible location
      // outside the building — introduced in the 2017 NEC, and a plan reviewer asks where it is.
      initiationDeviceArticle: "690.12(C)",
    },
    labels: {
      rapidShutdown: "690.56(C)",
      rapidShutdownWording: "SOLAR PV SYSTEM IS EQUIPPED WITH RAPID SHUTDOWN",
      disconnect: "690.13(B)",
      dcSource: "690.53",
      pointOfInterconnection: "690.54",
      powerSourceDirectory: "705.10",
      standAloneDirectory: "710.10",
      dcConductorMarking: "690.31(G)(3)",
    },
    interconnection: { supplySide: "705.12(A)", loadSide: "705.12(B)", busbar120: "705.12(B)(2)(3)(b)" },
  },
  2020: {
    edition: 2020,
    rapidShutdown: {
      article: "690.12",
      limits: "outside the array boundary (1 ft from the array) controlled conductors limited to 30 V within 30 seconds; inside the boundary a listed PV hazard control system, 80 V within 30 seconds, or no exposed wiring",
      insideBoundaryArticle: "690.12(B)(2)",
      requiresListedEquipment: true,
      noExposedWiringOption: true,
      initiationDeviceArticle: "690.12(C)",
    },
    labels: {
      rapidShutdown: "690.56(C)",
      rapidShutdownWording: "SOLAR PV SYSTEM IS EQUIPPED WITH RAPID SHUTDOWN",
      disconnect: "690.13(B)",
      dcSource: "690.53",
      pointOfInterconnection: "690.54",
      powerSourceDirectory: "705.10",
      standAloneDirectory: "710.10",
      dcConductorMarking: "690.31(D)(2)",
    },
    interconnection: { supplySide: "705.11", loadSide: "705.12", busbar120: "705.12(B)(3)(2)" },
  },
  // 2023 RAPID SHUTDOWN IS NOT A COPY OF 2020 (#215). Two changes this table carries:
  //   - 690.12(B)(2) option (3), "no exposed wiring methods or conductive parts", was deleted (such
  //     arrays are now evaluated as PV hazard control systems under UL 3741);
  //   - the rapid-shutdown marking moved from 690.56(C) into 690.12(D) ("Buildings with Rapid
  //     Shutdown"; 690.12(D)(1) more than one RSD type, 690.12(D)(2) the switch label).
  // 2023 also added two exceptions (non-enclosed detached structures such as carports and trellises;
  // circuits from arrays not on the building terminated on its exterior per 230.6) that this table
  // does not encode.
  // Source: secondary — Solar Power World, "2023 code changes: rapid shutdown requirements" (Jan
  // 2024) and IAEI Magazine, "2023 National Electrical Code and Photovoltaic Power Systems". The
  // NFPA 70-2023 text itself was not read, so the cells resting on it are listed in `unconfirmed`
  // until a person checks them against the code.
  2023: {
    edition: 2023,
    rapidShutdown: {
      article: "690.12",
      limits: "outside the array boundary (1 ft from the array) controlled conductors limited to 30 V within 30 seconds; inside the boundary a listed PV hazard control system or 80 V within 30 seconds (the 2020 \"no exposed wiring\" option was deleted)",
      insideBoundaryArticle: "690.12(B)(2)",
      requiresListedEquipment: true,
      noExposedWiringOption: false,
      initiationDeviceArticle: "690.12(C)",
    },
    labels: {
      rapidShutdown: "690.12(D)",
      rapidShutdownWording: "SOLAR PV SYSTEM IS EQUIPPED WITH RAPID SHUTDOWN",
      disconnect: "690.13(B)",
      dcSource: "690.53",
      // The 2023 revision reworked 705.12 and the 690.31 marking provisions; the point-of-
      // interconnection marking, the stand-alone directory and the DC-conductor marking
      // subsection are left unknown rather than carried forward from 2020 by assumption.
      pointOfInterconnection: null,
      powerSourceDirectory: "705.10",
      standAloneDirectory: null,
      dcConductorMarking: null,
    },
    interconnection: { supplySide: "705.11", loadSide: "705.12", busbar120: null },
    unconfirmed: ["rapidShutdown.limits", "rapidShutdown.noExposedWiringOption", "labels.rapidShutdown"],
  },
};

/** The NEC edition year the jurisdiction has adopted for the ELECTRICAL family (a state code such
 *  as the OESC counts by the NEC year it is based on), or null when no electrical entry is on file. */
export function adoptedNecEdition(adoptedCodes: CodeEdition[] | undefined): number | null {
  for (const c of adoptedCodes ?? []) {
    if (codeFamilyOf(c) !== "electrical") continue;
    const year = String(c.basedOn || "").match(/\b(?:19|20)\d{2}\b/)?.[0] ?? String(c.edition || "").match(/\b(?:19|20)\d{2}\b/)?.[0];
    if (year) return Number(year);
  }
  return null;
}

/** The table row for an adopted edition, or null when the year is not one the table knows (an
 *  older cycle, a 2026 adoption, or no electrical entry) — the caller keeps its generic rule. */
export function necEditionRequirements(edition: number | null): NecEditionRequirements | null {
  return edition != null && Object.prototype.hasOwnProperty.call(NEC_EDITION_REQUIREMENTS, edition)
    ? NEC_EDITION_REQUIREMENTS[edition as NecEditionYear]
    : null;
}
