import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'form-fees-'));
process.env.AUTOPILOT_DB_PATH=path.join(dir,'test.sqlite');
process.env.SEED_TEST_INSTALLER='false';
const {openDatabase}=await import('../src/db');
const {saveFeeSchedule,feeForProject,corroborateBrackets,bracketDescribesFormula}=await import('../src/feeSchedules');
const {resolveSource,fillLoadedForm}=await import('../src/ahjForms');
const {curatedFormMap}=await import('../src/curatedAhjForms');
const {extractLabels}=await import('../src/formTextLayer');
const {readFeeTableFromPdf}=await import('../src/jurisdictionHarvest');
const db=await openDatabase();
try{
 const buildingTable=await readFeeTableFromPdf(fs.readFileSync('backend/test/fixtures/tigard-building.pdf'));
 assert.equal(buildingTable.brackets[0]?.feeUsd,180,'Read flat solar fees printed on building application');
 assert.ok(buildingTable.surchargeEvidence?.[0].includes('21.60'));
 const electricalTable=await readFeeTableFromPdf(fs.readFileSync('backend/test/fixtures/tigard-electrical.pdf'));
 assert.deepEqual(electricalTable.brackets.map(b=>b.feeUsd),[100.7,133.56,200.34],'Exclude adjacent limited-energy table and inspection-count column');
 const url='https://example.gov/fees.pdf';
 const row='Renewable energy 5.01 to 15 kva | $133.56';
 const surcharge='Note: A 12% surcharge fee as mandated by the State Building Codes Division is applied to all permit fees, investigation fees and inspection fees listed.';
 const finding={found:true,reason:'',basis:'system_kw' as const,brackets:[{minKw:5.01,maxKw:15,feeUsd:133.56,label:'Renewable energy 5.01 to 15 kva'}],notes:'',sourceUrl:url,sourceQuote:row,sourceKind:'official',discipline:'electrical'};
 const ledger={evidence:[{url,via:'http' as const,status:200,kind:'pdf' as const,bytes:100,handed:2}],corpus:[row+'\n'+surcharge]};
 const saved=saveFeeSchedule(db,{state:'OR',ahj:'Tigard',track:'permit',discipline:'electrical'},finding,{corroborateAgainst:ledger});
 assert.equal(saved.saved,true);
 const project={state:'OR',ahj:'Tigard',city:'Tigard',utility:'',systemSizeAcKw:9.984,systemSizeDcKw:9.84,parserSnapshot:{}} as never;
 const line=feeForProject(db,project,'electrical')!.lines![0];
 assert.equal(line.baseFeeUsd,133.56);
 assert.equal(line.stateSurchargeUsd,16.03);
 assert.equal(line.feeUsd,149.59);
 assert.ok(line.bracketQuote.includes('16.03'));
 const ctx={project,client:{},snapshot:{},publishedFeeLines:[line]};
 assert.equal(resolveSource('computed.electricalBaseFee',ctx),'133.56');
 assert.equal(resolveSource('computed.electricalTotalFee',ctx),'149.59');
 assert.equal(resolveSource('computed.electricalTotalFee',{...ctx,snapshot:{electricalPlanReviewRequired:'yes'}}),'');
 for(const snapshot of [{buildingStories:4},{electricalPlanReviewRequired:true}]) {
  assert.equal(resolveSource('computed.electricalTotalFee',{...ctx,snapshot}),'');
  assert.equal(feeForProject(db,{...(project as any),parserSnapshot:snapshot},'electrical')?.feeUsd,null,'Known review trigger must refuse incomplete quote as well as PDF total');
 }
 assert.equal(resolveSource('computed.electricalTotalFee',{...ctx,publishedFeeLines:[{...line,stateSurchargeUsd:undefined}]}),'');
 assert.equal(resolveSource('computed.electricalBaseFee',{...ctx,publishedFeeLines:[{...line,feeUsd:null}]}),'');
 assert.equal(resolveSource('computed.electricalBaseFee',{...ctx,publishedFeeLines:[]}), '','No Portland fallback');
 assert.equal(corroborateBrackets({...finding,brackets:[{...finding.brackets[0],stateSurcharge:{percent:12,quote:'forged',sourceUrl:url}}]}, {...ledger,corpus:[row]})[0].stateSurcharge,undefined);
 assert.equal(corroborateBrackets(finding,{...ledger,corpus:[row+'\n12% of project valuation']})[0].stateSurcharge,undefined);
 assert.equal(corroborateBrackets(finding,{...ledger,corpus:[row,surcharge]})[0].stateSurcharge,undefined,'Different document does not support surcharge');
 assert.ok(bracketDescribesFormula('>100 kva no - additional charge'),'An incremental zero is not a free permit');
 const coosUrl='https://co.coos.or.us/files/schedule.pdf',formUrl='https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf';
 const coosFinding={...finding,sourceUrl:coosUrl};
 const coosLedger={evidence:[{...ledger.evidence[0],url:coosUrl},{...ledger.evidence[0],url:formUrl}],corpus:[row,'12% surcharge (.12 x subtotal)\nCommunity Dev surcharge 5%']};
 assert.equal(corroborateBrackets(coosFinding,coosLedger)[0].communitySurcharge?.percent,5);
 assert.equal(corroborateBrackets({...coosFinding,discipline:'structural'},coosLedger)[0].communitySurcharge,undefined,'County electrical rule must not reach structural permit');
 assert.equal(corroborateBrackets(coosFinding,{...coosLedger,evidence:[coosLedger.evidence[0],{...coosLedger.evidence[1],url:'https://other.gov/form.pdf'}]})[0].communitySurcharge,undefined);
 for(const label of ['Renewable permit fee (includes state surcharge)','Renewable permit fee (includes 12% state surcharge)','Renewable total permit fee']){
  const inclusive={...coosFinding,brackets:[{feeUsd:112,label}]};
  for(const extra of [surcharge,'12% surcharge (.12 x subtotal)\nCommunity Dev surcharge 5%']) {
   const proof={...coosLedger,corpus:[`${label} | $112.00\n${extra}`,coosLedger.corpus[1]]};
   const bracket=corroborateBrackets(inclusive,proof)[0];
   assert.equal(bracket.stateSurcharge,undefined,label);
   assert.equal(bracket.communitySurcharge,undefined,label);
  }
 }
 saveFeeSchedule(db,{state:'OR',ahj:'Coos County',track:'permit',discipline:'electrical'},coosFinding,{corroborateAgainst:coosLedger});
 const coosLine=feeForProject(db,{...(project as any),ahj:'Coos County'},'electrical')!.lines![0];
 assert.equal(coosLine.feeUsd,156.27); // 133.56 + 16.03 + 6.68; round each bill component
 assert.equal(resolveSource('computed.coosElectricalTotal',{...ctx,publishedFeeLines:[coosLine]}),'156.27');
 assert.equal(resolveSource('computed.coosElectricalTotal',ctx),'','Do not call a base + state-only fee a Coos grand total');
 const bytes=fs.readFileSync('backend/test/fixtures/tigard-electrical.pdf');
 const map=curatedFormMap(bytes,url)!.map;
 const output=path.join(dir,'filled.pdf');
 const result=await fillLoadedForm({...map,id:'test',notes:[],status:'verified',matchJurisdictions:['tigard'],version:'test'} as never,bytes,ctx,output);
 assert.ok(result.unmappedRequested?.includes('owner mailing address'));
 assert.ok(result.unmappedRequested?.includes('owner email'));
 const labels=await extractLabels(fs.readFileSync(output));
 assert.ok(labels.some(l=>l.page===1&&l.str==='133.56'&&l.y<650&&l.y>630),'page 2 solar tier filled');
 assert.ok(labels.some(l=>l.page===0&&l.str==='149.59'),'application grand total filled');
 const today=resolveSource('computed.todaySigned',ctx);
 assert.ok(!labels.some(l=>l.str===today),'No signing date before a signature is applied');
 const {createCanvas}=await import('@napi-rs/canvas');
 const canvas=createCanvas(100,20);
 canvas.getContext('2d').fillRect(5,8,90,4);
 const signature={bytes:canvas.toBuffer('image/png'),mime:'image/png',widthPx:100,heightPx:20,name:'Test Signer'};
 for(const filename of ['tigard-electrical.pdf','tigard-building.pdf']) {
  const template=fs.readFileSync('backend/test/fixtures/'+filename);
  const mapped=curatedFormMap(template,url)!.map;
  const filled=await fillLoadedForm({...mapped,id:'signed-test',notes:[],status:'verified',matchJurisdictions:['tigard'],version:'test'} as never,template,{
   ...ctx,snapshot:{constructionCategory:'Other',constructionCategoryOther:'Solar',homeownerMailingAddress:'12 Example Way',homeownerMailingCityStateZip:'Example, OR 97000',homeownerPhone:'503-555-0142',homeownerEmail:'owner@example.com'},
   signatures:{applicant:signature,electrician:{...signature,name:'Test Electrician'}},
  },output);
  const signedLabels=await extractLabels(fs.readFileSync(output));
  assert.ok(signedLabels.some(l=>l.str==='Solar'&&l.y>550&&l.y<630),'Solar belongs in construction category Other');
  assert.ok(!filled.unmappedRequested?.includes('construction category'));
  for(const text of ['12 Example Way','Example, OR 97000','503-555-0142']) assert.ok(signedLabels.some(l=>l.str===text),filename+': '+text);
  if(filename==='tigard-electrical.pdf') assert.ok(signedLabels.some(l=>l.str==='owner@example.com'));
  assert.ok(!filled.unmappedRequested?.includes('owner mailing address'));
  const dates=signedLabels.filter(l=>l.str===today);
  assert.equal(dates.length,filename==='tigard-electrical.pdf'?2:1,'Only matched operator signatures date their own rows');
  assert.ok(dates.every(l=>l.x>=282&&l.y<85),'Dates belong in bottom signature date cells, not owner installation section');
 }
 console.log('formFeeCompleteness passed: sourced surcharge, component rounding, no fallback, required-field gaps and both PDF pages');
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
