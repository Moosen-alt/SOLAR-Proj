import Database from 'better-sqlite3';
const db = new Database('C:/Users/isobl/SOLAR-Proj/backend/data/autopilot.sqlite', {readonly:true, fileMustExist:true});
const rows = db.prepare("select id,profile_key,portal_platform,status,discipline,portal_url,length(steps_json) len from portal_recipes").all();
for (const r of rows) console.log(JSON.stringify(r));
