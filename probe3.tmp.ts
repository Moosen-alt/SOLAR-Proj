import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe3-"));
const DBP = path.join(tmpDir, "t.sqlite");
const PORT = 4866;
const env: Record<string,string> = { ...process.env, AUTOPILOT_DB_PATH: DBP, PORT: String(PORT), AUTH_ENABLED: "true",
  ADMIN_EMAIL: "o@t.test", ADMIN_PASSWORD: "owner-pass-1", AUTOPILOT_AUTO_START: "0",
  SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "",
  SESSION_ENCRYPTION_KEY: "k", NO_PROXY: "*", no_proxy: "*" } as Record<string,string>;
for (const k of ["HTTPS_PROXY","https_proxy","HTTP_PROXY","http_proxy"]) delete env[k];
const s = spawn("npx", ["tsx", "backend/src/server.ts"], { env, stdio: ["ignore","inherit","inherit"] });
const B = `http://127.0.0.1:${PORT}`;
let up=false;
for (let i=0;i<40;i++){ try{ if((await fetch(`${B}/health`)).ok){up=true;break;} }catch{} await new Promise(r=>setTimeout(r,500)); }
console.log("UP:", up);
const login = async (e:string,p:string)=>{const r=await fetch(`${B}/api/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:e,password:p})}); return String(r.headers.get("set-cookie")||"").split(";")[0];};
const call=(c:string)=>(p:string,i:RequestInit={})=>{const h=new Headers(i.headers);h.set("cookie",c);if(i.body&&!h.has("content-type"))h.set("content-type","application/json");return fetch(`${B}${p}`,{...i,headers:h});};
const owner=call(await login("o@t.test","owner-pass-1"));
const org=(await (await owner("/api/orgs",{method:"POST",body:JSON.stringify({name:"Acme",edition:"full",products:["autopilot"]})})).json()).org;
console.log("ORG:", JSON.stringify(org));
console.log("USERCREATE:", (await owner(`/api/orgs/${org.id}/users`,{method:"POST",body:JSON.stringify({name:"A",email:"a@t.test",password:"tenant-pass-12345"})})).status);
const a = call(await login("a@t.test","tenant-pass-12345"));
console.log("ME:", JSON.stringify(await (await a("/api/auth/me")).json()));
const pr = await a("/api/projects",{method:"POST",body:JSON.stringify({owner:"Alice",street:"1 Way",city:"Salem",state:"OR",zip:"97301",ahj:"Salem",utility:"PGE",dcKw:"7"})});
const body = await pr.json();
console.log("PROJ:", pr.status, JSON.stringify(body).slice(0,150));
const list = await (await a("/api/projects")).json();
console.log("LIST:", list.projects?.length, "total:", list.total);
const Database = (await import("better-sqlite3")).default;
const d = new Database(DBP, { readonly: true });
console.log("PROJECTS:", JSON.stringify(d.prepare("SELECT id, org_id FROM projects").all()));
console.log("USERS:", JSON.stringify(d.prepare("SELECT email, role, org_id FROM users").all()));
s.kill("SIGKILL");
process.exit(0);
