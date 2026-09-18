import {createHash} from "node:crypto";
import type {ProjectRecord} from "../../shared/src/types";
import type {OverlayField, SignaturePlacement} from "./ahjForms";

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
 if(source.ahj==='coos bay'){
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
   'Subtotal add ALL fees  minimum fee':'computed.electricalBaseFee',
   '12 surcharge 12 x subtotal':'computed.electricalStateSurcharge',
   'Community Dev surcharge 5':'computed.electricalCommunitySurcharge',
   'GRAND TOTAL fees and surcharges':'computed.coosElectricalTotal',
  });
  for (const [key,value] of Object.entries(textFields)) if (/^computed\.(?:electrical|coosElectrical)/.test(value)) fieldFontSizes[key]=8;
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
   at('computed.electricalBaseFee',537,95,p,49);
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
  at('snapshot.parcelNumber',124,building?425:505,p,230);
  at('computed.applicantSignerName',84,building?42:39,p,164);
  signatureFields.push({role:'applicant',page:p,x:117,y:building?62:54,width:232,height:building?16:14,dateX:282,dateY:building?42:39,dateSize:9,label:'Authorized signature'});
  at('lit:X',building?34:146,building?628:677,p,10); // alteration
  at('lit:X',building?67:67,building?346:448,p,10); // property owner
  at('lit:X',building?84:84,building?269:319,p,10); // applicant
 }
 return {source,map:{formName:source.formName,sourceUrl,fillMode:source.ahj==='coos bay'?'acroform' as const:'overlay' as const,textFields,fieldFontSizes,checkboxes,overlayFields:fields,signatureFields,requiredFields,preserveInteractive:source.ahj==='coos bay',notes:"Review listed missing details and obtain required signatures before filing. Mapped operator signing dates are filled only when the matching saved signature is applied. Owner-installation signatures are not auto-filled. Fee entries use the current saved jurisdiction lookup; printed rates may be historical. Owner mailing/contact details require actual owner information."}};
}

