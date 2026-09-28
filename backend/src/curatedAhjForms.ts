import {createHash} from "node:crypto";
import type {ProjectRecord} from "../../shared/src/types";
import type {OverlayField, SignaturePlacement} from "./ahjForms";

// Public sources checked against the authority's forms pages. Exact byte hashes
// prevent a revised PDF from silently inheriting old coordinates. No customer
// data or signatures belong in these maps, and no fee amount goes into a MAP.
//
// THE ONE FEE EXCEPTION IS A SEED'S OWN PRINTED LADDER (`printedFees`, Marion E-01 — operator finding
// 2026-09-27: Michael's E-01 printed Qty 1 and a blank Total, Subtotal, surcharge and TOTAL because no
// county schedule is on file). It is the fee table printed on THAT hash's blank, read off the form
// itself; the fill falls back to it only where no saved jurisdiction fee line is on file, only up to
// the size the form prices without per-kVA math or plan review, and says so on the fill result. It is
// never written to the fee store and never "verified" (hard rule 3) — a saved line always wins. A seed
// whose printed table is known to be stale (Coos County, 1.70x under the adopted schedule) carries none.
export interface PrintedFeeLadder {
  discipline: "electrical";
  /** The form's solar rows: inclusive upper bound in kVA (the same bounds as ahjForms.feeBracket), ascending. */
  tiers: ReadonlyArray<{ readonly maxKva: number; readonly feeUsd: number }>;
  /** Above this the form's own figures need per-kVA math and plan review: never computed. */
  autoMaxKva: number;
  /** "State surcharge (12% of permit fee)", as printed. */
  stateSurchargePercent: number;
  /** Said on the fill result whenever the ladder priced the form. */
  note: string;
}
export const CURATED_AHJ_FORMS = [
  {ahj:"tigard",state:"OR",formType:"building_application",formName:"City of Tigard Residential Building Permit Application",url:"https://www.tigard-or.gov/home/showpublisheddocument/42/639007759919470000",hash:"af2a97754e8300ce5341c316b4739a3e68df7da31688a4b993910f6894c784c7",documentDate:"01/25/2023 (printed footer)"},
  {ahj:"tigard",state:"OR",formType:"electrical_application",formName:"City of Tigard Electrical Permit Application",url:"https://www.tigard-or.gov/home/showpublisheddocument/44/637615268530600000",hash:"631bc73563f644c600b363c0f5f058b7a3d4eb8684551ac1e4a57a1a50fcb1b6",documentDate:"Rev 06/17/2015"},
  // The form only says "Revised 2025"; do not invent a month/day.
  {ahj:"coos bay",state:"OR",formType:"electrical_application",formName:"Coos County Electrical Permit Application",url:"https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf",hash:"7ef28457e32b802f53e47ffd8a2494548cc11b60c839be780b2344217c6f2d0c",documentDate:"Revised 2025"},
  // MARION COUNTY'S OWN APPLICATIONS — keyed to the ISSUING AGENCY, never to a city it issues for
  // (applicationDocsAgency.formAuthorityFor). A City of Jefferson job reaches them because the
  // per-job lookup cites Marion County as the issuer of both permits. Fetched once each on
  // 2026-09-27 from co.marion.or.us (recorded in .probe/agency-apps/live-fetch/fetch-log.json);
  // B-01S is the URL the lookup cited, E-01 was found on the county's forms listing. The B-01S
  // prints no revision date; the E-01 footer prints only "06/20" — do not invent a day.
  {ahj:"marion county",state:"OR",formType:"building_application",applicationKind:"prescriptive",formName:"Marion County Prescriptive Solar Photovoltaic Installation Permit Application (B-01S)",url:"https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf",hash:"8c8daff4239868c9a156bcabf6e6690eb3677541b24c34ca7eec59bb8bd0a732",documentDate:""},
  // Its FEE SCHEDULE block, as printed on this revision (backend/test/fixtures/marion-e-01.pdf): SOLAR
  // 5 kva or less $79.00; 5.01 to 15 kva $94.00; 15.01 to 25 kva $156.00; in excess of 25 kva $156.00
  // plus $6.25 per additional kva up to 100; over 100 kva $624.75; plan review 25% when the system
  // exceeds 25 kva; state surcharge 12% of permit fee. Only the flat rows are carried (<= 25 kVA).
  {ahj:"marion county",state:"OR",formType:"electrical_application",formName:"Marion County Renewable Electrical Energy Permit Application (E-01)",url:"https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf",hash:"bd723dfa527a18990d40ce9871ae20a8a31e5d9e85a383db610d69ed027948a4",documentDate:"06/20 (printed footer)",
   printedFees:{discipline:"electrical",tiers:[{maxKva:5,feeUsd:79},{maxKva:15,feeUsd:94},{maxKva:25,feeUsd:156}],autoMaxKva:25,stateSurchargePercent:12,
    note:"Fees are the schedule printed on this form (Marion County E-01, footer 06/20): no saved Marion County electrical fee schedule is on file. Confirm the county's current fees before filing."}},
] as const;
type CuratedSource = (typeof CURATED_AHJ_FORMS)[number];
const curatedKey = (ahj: string) => String(ahj ?? "").trim().toLowerCase().replace(/^city of\s+/,"");
/** The seed's own application kind (the building side's two mutually exclusive forms), else null. */
export function curatedApplicationKind(source: CuratedSource): "prescriptive" | "structural" | null {
 return "applicationKind" in source ? source.applicationKind : null;
}
/** Every seed held for this authority (an AHJ, or the agency that issues its permits). */
export function curatedFormSourcesFor(authority: string, state: string): CuratedSource[] {
 const name=curatedKey(authority);
 return CURATED_AHJ_FORMS.filter(f=>f.ahj===name&&f.state===String(state ?? "").trim().toUpperCase());
}
/** The seed for this authority + form type — and, on the building side, for the path's KIND: the
 *  B-01S is the PRESCRIPTIVE application and must never be fetched for an engineered project. */
export function curatedFormSource(project: Pick<ProjectRecord,"ahj"|"state">,formType:string,kind?:"prescriptive"|"structural"|null){
 return curatedFormSourcesFor(project.ahj, project.state).find(f=>f.formType===formType&&(!kind||!curatedApplicationKind(f)||curatedApplicationKind(f)===kind));
}
/** The fee ladder PRINTED on this exact blank (by its sha256), else null. Keyed by the bytes, not by a
 *  stored map, so a row stored before the ladder existed (Michael's E-01) reads it too. */
export function curatedPrintedFees(bytes:Uint8Array):PrintedFeeLadder|null{
 const hash=createHash("sha256").update(bytes).digest("hex");
 const source=CURATED_AHJ_FORMS.find(f=>f.hash===hash);
 return source&&"printedFees" in source?source.printedFees as PrintedFeeLadder:null;
}
export function curatedFormMap(bytes:Uint8Array,sourceUrl:string){
 const source=CURATED_AHJ_FORMS.find(f=>f.hash===createHash("sha256").update(bytes).digest("hex"));
 if(!source)return null;
 const fields:OverlayField[]=[];
 const signatureFields:SignaturePlacement[]=[];
 const at=(key:string,x:number,y:number,page:number,maxWidth=235)=>fields.push({source:key,x,y,page,size:9,maxWidth});
 const textFields:Record<string,string>={};
 const fieldFontSizes:Record<string,number>={};
 const checkboxes:Record<string,{source:string;equals?:string}>={};
 const requiredFields:Record<string,string>={
  "construction category":"computed.constructionCategory",
  "owner mailing address":"snapshot.homeownerMailingAddress",
  "owner mailing city/state/ZIP":"snapshot.homeownerMailingCityStateZip",
  "owner phone":"snapshot.homeownerPhone",
  "contractor CCB license":"client.ccbLicenseNumber",
 };
 if(source.formType==='electrical_application') requiredFields['owner email']='snapshot.homeownerEmail';
 const radioGroups:Record<string,{source:string;equals?:string;option:string}>={};
 let notes="Review listed missing details and obtain required signatures before filing. Mapped operator signing dates are filled only when the matching saved signature is applied. Owner-installation signatures are not auto-filled. Fee entries use the current saved jurisdiction lookup; printed rates may be historical. Owner mailing/contact details require actual owner information.";
 if(source.ahj==='marion county'){
  // Field names read off each blank's AcroForm (backend/test/fixtures/marion-*.pdf). Every text
  // field prints at 9 pt: the blanks declare auto-size (0 Tf), which set a 13-pt box's value at
  // ~11 pt beside 8-pt labels.
  delete requiredFields['construction category'];
  if(source.formType==='building_application'){
   Object.assign(textFields,{
    'Owner name':'project.homeownerName','Owner phone number':'computed.homeownerPhone','Job site address':'computed.streetAddress',
    City:'project.city',State:'project.state',ZIP:'project.zip',
    Name:'project.homeownerName',Address:'snapshot.homeownerMailingAddress',City_2:'computed.homeownerMailingCity',State_2:'computed.homeownerMailingState',ZIP_2:'computed.homeownerMailingZip',
    Phone:'computed.homeownerPhone',Email:'snapshot.homeownerEmail',
    'Business name':'client.installerCompanyName',Address_2:'client.installerStreet',City_3:'client.installerCity',State_3:'client.installerState',ZIP_3:'client.installerZip',
    Phone_2:'client.installerPhone',Email_2:'client.installerEmail','CCB license no':'client.ccbLicenseNumber','Print name':'computed.applicantSignerName',
    'Valuation of the installation':'computed.estimatedJobValue',
   });
   // "This section must be completed": three Yes/No radio groups (options Yes_n / No_n). Only an
   // affirmative fact ticks Yes; nothing here ever ticks No (a No answer means this is not the
   // prescriptive application at all). The two ZONING groups and "Approved by / Date" are the
   // CITY's block ("If within a city you must submit application to the city for zoning
   // approval") — never filled by us.
   radioGroups.undefined_3={source:'computed.roofMounted',equals:'yes',option:'Yes_3'};
   radioGroups.undefined_4={source:'computed.structureSfdOrAccessory',equals:'yes',option:'Yes_4'};
   // The attestation reads the SAME answers the state checklist prints (computed.checklistAllYes).
   radioGroups.undefined_5={source:'computed.checklistAllYes',equals:'yes',option:'Yes_5'};
   requiredFields['declared valuation']='computed.estimatedJobValue';
   requiredFields['structure type (single-family dwelling or accessory building) for the requirement row']='computed.structureSfdOrAccessory';
   requiredFields['every BCD 5952 checklist row answered Yes (the OSSC 3111.4.8 / 3111.5 attestation row)']='computed.checklistAllYes';
   // Certification signature (bottom left, Signature widget #1 at 32,106) with its Date box, and
   // the contractor block's Signature_2. The Signature field's OTHER widget is the owner-exempt
   // "Sign here" and is never stamped.
   signatureFields.push({role:'applicant',page:0,x:36,y:109,width:168,height:18,dateX:229,dateY:113,dateSize:9,label:'Applicant certification signature'});
   signatureFields.push({role:'applicant',page:0,x:368,y:207,width:200,height:20,label:'Contractor signature'});
   notes="Marion County's own prescriptive application (the county issues the permit). The 'within a city' zoning block (top left: Local Zoning Approval, permission to submit directly, Approved by / Date) is completed by the CITY before the county takes the application — left blank. Permit fees: (a) and (b) are printed; the zoning-review line and total are left for the county. "+notes;
  }else{
   Object.assign(textFields,{
    'Job site address':'computed.streetAddress',CityStateZip:'computed.cityStateZip','Project name':'project.homeownerName',
    'DESCRIPTION OF WORKRow1':'computed.descriptionOfWorkLine1','DESCRIPTION OF WORKRow2':'computed.descriptionOfWorkLine2',
    Name:'project.homeownerName',Address:'snapshot.homeownerMailingAddress','CityState ZIP':'snapshot.homeownerMailingCityStateZip',Phone:'computed.homeownerPhone',Email:'snapshot.homeownerEmail',
    'Business name':'client.installerCompanyName','Contact name':'client.installerContactName',Address_2:'client.installerStreet',CityStateZIP:'client.installerCityStateZip',
    Phone_2:'client.installerPhone',Email_2:'client.installerEmail','CCB License no':'client.ccbLicenseNumber','Electrical License no':'client.electricalLicenseNumber',
    'Supervising Electrician License no':'client.electricianLicenseNumber','Print name of signing supervisor':'client.electricalSupervisorName',
    // Solar rows only (the wind rows below them are another system). Qty is the kVA bracket the
    // system's AC size falls in; the Total is the saved jurisdiction fee line, else (<= 25 kVA) the
    // ladder printed on this blank (curatedPrintedFees), else blank.
    '5 kva or less':'computed.kvaTier5Qty','7900':'computed.electricalTier5Total',
    '501 to 15 kva':'computed.kvaTier15Qty','9400':'computed.electricalTier15Total',
    '1501 to 25 kva':'computed.kvaTier25Qty','15600':'computed.electricalTier25Total',
    Subtotal:'computed.electricalSubtotal','State surcharge 12 of permit fee':'computed.electricalStateSurcharge','TOTAL PERMIT FEE':'computed.electricalTotalFee',
   });
   checkboxes.undefined={source:'computed.residentialCategory',equals:'residential'};
   requiredFields['residential category of construction']='computed.residentialCategory';
   requiredFields['owner mailing city/state/ZIP']='snapshot.homeownerMailingCityStateZip';
   requiredFields['supervising electrician license']='client.electricianLicenseNumber';
   requiredFields['electrical permit fee (the county schedule, when not on file)']='computed.electricalTotalFee';
   signatureFields.push({role:'electrician',page:0,x:99,y:134,width:200,height:18,label:'Signature of signing supervisor'});
   notes="Marion County's own renewable-energy electrical application (the county issues the permit). The property-owner installation signature/date is never auto-filled. Fees: a saved Marion County fee schedule when one is on file, else the schedule printed on this form (systems up to 25 kVA; the fill says which). Systems over 25 kVA need the per-kVA line and plans review — not filled. "+notes;
  }
  for (const key of Object.keys(textFields)) fieldFontSizes[key]=/Tier|electrical(Subtotal|State|Total)/.test(textFields[key])?8:9;
 }else if(source.ahj==='coos bay'){
  Object.assign(textFields,{
   "Job site address":"computed.streetAddress",CityStateZIP:"computed.cityStateZip", "Project Name":"project.homeownerName",Parcel:"snapshot.parcelNumber",
   "DESCRIPTION OF WORKRow1":"computed.descriptionOfWork",Name:"project.homeownerName",Address:"snapshot.homeownerMailingAddress",CityStateZIP_2:"snapshot.homeownerMailingCityStateZip",Phone:"snapshot.homeownerPhone",Email:"snapshot.homeownerEmail",
   "Business name":"client.installerCompanyName",Address_2:"client.installerStreet",CityStateZIP_3:"client.installerCityStateZip",Phone_2:"client.installerPhone",Email_2:"client.installerEmail","Contractor CCB license":"client.ccbLicenseNumber","BCD license":"client.electricalLicenseNumber","Name of signing supervisor":"client.electricalSupervisorName","SS Lic":"client.electricianLicenseNumber",
  });
  checkboxes.Alteration={source:"lit:yes"};
  checkboxes["Single Family Dwelling"]={source:"computed.singleFamilyCategory",equals:"yes"};
  requiredFields['construction category']='computed.singleFamilyCategory';
  requiredFields['land-use approval number']='snapshot.landUseApprovalNumber';
  requiredFields['land-use approval date']='snapshot.landUseApprovalDate';
  requiredFields['Coos County surcharges and grand total']='computed.coosElectricalTotal';
  Object.assign(textFields,{
   'File Number of Approval':'snapshot.landUseApprovalNumber','Date of Approval':'snapshot.landUseApprovalDate',
   '5kva qty':'computed.electricalTier5Qty','5KVA TOTAL':'computed.electricalTier5Total',
   '15kva qty':'computed.electricalTier15Qty','15KVA TOTAL':'computed.electricalTier15Total',
   '25kva qty':'computed.electricalTier25Qty','25KVA TOTAL':'computed.electricalTier25Total',
   // Battery job on this electrical permit: ONE "Services or feeders (installation,
   // alteration, relocation) 200 amps or less" line (operator rule 2026-09-24,
   // batteryServiceFeeder.ts). Field names read off the blank's AcroForm; the row
   // text at p1 y=472.7 is "200 amps or less" under "Services or feeders", NOT the
   // "temp 200 amps" row below it or the "MD SERVICE/FEEDER" row above it.
   '200 AMPS QTY':'computed.servicesFeeders200Qty','200 AMPS TOTAL':'computed.servicesFeeders200Total',
   // "add ALL fees" is the whole application, services line included — not the kVA row.
   'Subtotal add ALL fees  minimum fee':'computed.electricalSubtotal',
   '12 surcharge 12 x subtotal':'computed.electricalStateSurcharge',
   'Community Dev surcharge 5':'computed.electricalCommunitySurcharge',
   'GRAND TOTAL fees and surcharges':'computed.coosElectricalTotal',
  });
  for (const [key,value] of Object.entries(textFields)) if (/^computed\.(?:electrical|coosElectrical|servicesFeeders)/.test(value)) fieldFontSizes[key]=8;
  for(const [bucket,y] of [['le5',254],['5to15',243],['15to25',231]] as const)
   fields.push({source:'computed.electricalBaseFee',x:478,y,page:0,size:8,maxWidth:34,onlyIf:{source:'computed.feeBracket',equals:bucket}});
 }else{
  const building=source.formType==='building_application',p=building?2:0;
  at('computed.streetAddress',building?104:188,building?532:598,p,building?251:166);
  at('computed.cityStateZip',101,building?516:584,p);
  at('project.homeownerName',building?219:209,building?501:568,p,135);
  // Separate lines keep a long equipment description from being cut off.
  at('lit:Install roof-mounted photovoltaic solar system.',32,building?392:474,p,315);
  at('computed.systemSize',32,building?376:458,p,315);
  at('project.homeownerName',63,building?330:433,p,290);
  at('snapshot.homeownerMailingAddress',74,building?314:417,p,275);
  at('snapshot.homeownerMailingCityStateZip',101,building?297:401,p,252);
  at('snapshot.homeownerPhone',88,building?284:385,p,108);
  if(!building)at('snapshot.homeownerEmail',65,370,p,285);
  for(const [key,x,by,ey,width] of [
   ['installerCompanyName',106,253,304,245],['installerStreet',74,222,272,277],['installerCityStateZip',101,207,256,250],['installerPhone',88,191,240,108],['installerEmail',65,177,225,286],
   ['installerCompanyName',106,145,197,245],['installerStreet',74,128,179,277],['installerCityStateZip',101,113,164,250],['installerPhone',88,98,147,108],['ccbLicenseNumber',80,83,114,building?265:48]
  ] as const)at('client.'+key,x,building?by:ey,p,width);
  at('client.installerContactName',101,building?237:288,p,247);
  if(!building){
   signatureFields.push({role:'electrician',page:p,x:175,y:96,width:174,height:14,dateX:282,dateY:81,dateSize:9,label:'Supervising electrician signature'});
   at('client.installerEmail',65,131,p,286);
   at('client.electricalLicenseNumber',198,114,p,50);
   at('client.electricianLicenseNumber',304,114,p,46);
   at('computed.electricianSignerName',84,81,p,160);
   // Page-1 "Subtotal" sums the WHOLE fee schedule (services line included); the
   // page-2 renewable subtotal below stays the kVA line alone.
   at('computed.electricalSubtotal',537,95,p,49);
   // Battery job: "Services or feeders installation, alteration, and/or relocation —
   // 200 amps or less" (p1 row baseline y=433.9; Qty. header x=487, Total header
   // x=551 — the same offsets as the page-2 renewable rows' 480/542 under 482/551).
   fields.push({source:'computed.servicesFeeders200Qty',x:485,y:434,page:p,size:8,maxWidth:16});
   fields.push({source:'computed.servicesFeeders200Total',x:542,y:434,page:p,size:8,maxWidth:31});
   at('computed.electricalStateSurcharge',537,72,p,49);
   at('computed.electricalTotalFee',537,60,p,49);
   at('lit:X',487,454,p,10); // renewable-energy table on page 2
   for(const [bucket,y] of [['le5',657],['5to15',642],['15to25',628]] as const){
    for(const [key,x,width] of [['computed.renewableFeeQty',480,16],['computed.electricalBaseFee',542,31]] as const){
     fields.push({source:key,x,y,page:1,size:8,maxWidth:width,onlyIf:{source:'computed.feeBracket',equals:bucket}});
    }
   }
   at('computed.electricalBaseFee',541,456,1,34);
   requiredFields['electrical fee including required surcharges']='computed.electricalTotalFee';
  }else{
   at('computed.declaredValuation',487,601,p,98);
   at('snapshot.buildingStories',491,551,p,90);
   requiredFields['declared job valuation']='computed.declaredValuation';
  }
  fields.push({source:'lit:X',x:34,y:building?594:640,page:p,size:9,maxWidth:10,onlyIf:{source:'computed.constructionCategory',equals:'residential'}});
  fields.push({source:'lit:X',x:building?205:249,y:building?562:625,page:p,size:9,maxWidth:10,onlyIf:{source:'computed.constructionCategory',equals:'other'}});
  fields.push({source:'snapshot.constructionCategoryOther',x:building?246:289,y:building?563:625,page:p,size:9,maxWidth:building?105:64,onlyIf:{source:'computed.constructionCategory',equals:'other'}});
  at('snapshot.parcelNumber',124,building?425:505,p,230);
  at('computed.applicantSignerName',84,building?42:39,p,164);
  signatureFields.push({role:'applicant',page:p,x:117,y:building?62:54,width:232,height:building?16:14,dateX:282,dateY:building?42:39,dateSize:9,label:'Authorized signature'});
  at('lit:X',building?34:146,building?628:677,p,10); // alteration
  at('lit:X',building?67:67,building?346:448,p,10); // property owner
  at('lit:X',building?84:84,building?269:319,p,10); // applicant
 }
 const acro=source.ahj==='coos bay'||source.ahj==='marion county';
 const kind=curatedApplicationKind(source);
 return {source,map:{formName:source.formName,sourceUrl,fillMode:acro?'acroform' as const:'overlay' as const,textFields,fieldFontSizes,checkboxes,radioGroups,overlayFields:fields,signatureFields,requiredFields,preserveInteractive:acro,...(kind?{applicationKind:kind}:{}),notes}};
}

