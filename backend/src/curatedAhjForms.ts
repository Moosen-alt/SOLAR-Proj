import {createHash} from "node:crypto";
import type {ProjectRecord} from "../../shared/src/types";
import type {OverlayField} from "./ahjForms";

// Public sources checked against the authority's forms pages. Exact byte hashes
// prevent a revised PDF from silently inheriting old coordinates. No customer
// data, signatures, or printed historical fee amounts belong in these maps.
export const CURATED_AHJ_FORMS = [
  {ahj:"tigard",state:"OR",formType:"building_application",formName:"City of Tigard Residential Building Permit Application",url:"https://www.tigard-or.gov/home/showpublisheddocument/42/639007759919470000",hash:"af2a97754e8300ce5341c316b4739a3e68df7da31688a4b993910f6894c784c7",documentDate:"01/25/2023 (printed footer)"},
  {ahj:"tigard",state:"OR",formType:"electrical_application",formName:"City of Tigard Electrical Permit Application",url:"https://www.tigard-or.gov/home/showpublisheddocument/44/637615268530600000",hash:"631bc73563f644c600b363c0f5f058b7a3d4eb8684551ac1e4a57a1a50fcb1b6",documentDate:"Rev 06/17/2015"},
  // The form only says "Revised 2025"; do not invent a month/day.
  {ahj:"coos bay",state:"OR",formType:"electrical_application",formName:"Coos County Electrical Permit Application",url:"https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf",hash:"7ef28457e32b802f53e47ffd8a2494548cc11b60c839be780b2344217c6f2d0c",documentDate:"Revised 2025"},
] as const;
export function curatedFormSource(project: Pick<ProjectRecord,"ahj"|"state">,formType:string){
 const name=project.ahj.trim().toLowerCase().replace(/^city of\s+/,"");
 return CURATED_AHJ_FORMS.find(f=>f.ahj===name&&f.state===project.state.toUpperCase()&&f.formType===formType);
}
export function curatedFormMap(bytes:Uint8Array,sourceUrl:string){
 const source=CURATED_AHJ_FORMS.find(f=>f.hash===createHash("sha256").update(bytes).digest("hex"));
 if(!source)return null;
 const fields:OverlayField[]=[];
 const at=(key:string,x:number,y:number,page:number,maxWidth=235)=>fields.push({source:key,x,y,page,size:9,maxWidth});
 const textFields:Record<string,string>={};
 const checkboxes:Record<string,{source:string;equals?:string}>={};
 if(source.ahj==='coos bay'){
  Object.assign(textFields,{
   "Job site address":"computed.streetAddress",CityStateZIP:"computed.cityStateZip", "Project Name":"project.homeownerName",Parcel:"snapshot.parcelNumber",
   "DESCRIPTION OF WORKRow1":"computed.descriptionOfWork",Name:"project.homeownerName",Address:"snapshot.homeownerMailingAddress",CityStateZIP_2:"snapshot.homeownerMailingCityStateZip",Phone:"snapshot.homeownerPhone",Email:"snapshot.homeownerEmail",
   "Business name":"client.installerCompanyName",Address_2:"client.installerStreet",CityStateZIP_3:"client.installerCityStateZip",Phone_2:"client.installerPhone",Email_2:"client.installerEmail","Contractor CCB license":"client.ccbLicenseNumber","BCD license":"client.electricalLicenseNumber","Name of signing supervisor":"client.electricalSupervisorName","SS Lic":"client.electricianLicenseNumber",
  });
  checkboxes.Alteration={source:"lit:yes"};
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
   at('client.installerEmail',65,131,p,286);
   at('client.electricalLicenseNumber',198,114,p,50);
   at('client.electricianLicenseNumber',304,114,p,46);
   at('computed.electricianSignerName',84,81,p,160);
  }
  at('computed.applicantSignerName',84,building?42:39,p,164);
  at('lit:X',building?34:146,building?628:677,p,10); // alteration
  at('lit:X',building?67:67,building?346:448,p,10); // property owner
  at('lit:X',building?84:84,building?269:319,p,10); // applicant
 }
 return {source,map:{formName:source.formName,sourceUrl,fillMode:source.ahj==='coos bay'?'acroform' as const:'overlay' as const,textFields,checkboxes,overlayFields:fields,signatureFields:[],notes:"Exact official revision map. Review missing particulars and obtain required signatures before filing. Printed historical fees are not used as current quotes."}};
}

