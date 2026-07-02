#!/bin/bash
set -e
export AUTOPILOT_DB_PATH=/tmp/status-verify.sqlite
rm -f /tmp/status-verify.sqlite*
export PORT=4991 SEED_TEST_INSTALLER=false AUTH_ENABLED=true ADMIN_EMAIL=a@a.test ADMIN_PASSWORD=verify-pass-123 MONITOR_INTERVAL_MINUTES=0 LOG_LEVEL=warn
npx tsx backend/src/server.ts &
SRV=$!
sleep 6
echo "--- health:"; curl -s localhost:4991/health | head -c 60; echo
echo "--- dashboard w/o login (expect redirect/401):"; curl -s -o /dev/null -w "%{http_code}" localhost:4991/api/projects; echo
echo "--- bad status token (expect 404):"; curl -s -o /dev/null -w "%{http_code}" localhost:4991/api/public/status/not-a-token; echo
# seed a project + token directly
TOKEN=$(npx tsx -e "
const { openDatabase } = await import('./backend/src/db.ts');
const { createClient } = await import('./backend/src/clients.ts');
const { createProject } = await import('./backend/src/repository.ts');
const { ensureStatusShareToken } = await import('./backend/src/clientNotifier.ts');
const db = await openDatabase();
const c = createClient(db, { companyName: 'Verify LLC', ccbLicenseNumber: '444', businessEmail: 'x@y.test', businessPhone: '5' });
const d = createProject(db, { clientId: c.id, owner: 'Pub Test', street: '7 Public Way', city: 'Salem', state: 'OR', ahj: 'Salem', utility: 'PGE', dcKw: '6', acKw: '5' });
console.log(ensureStatusShareToken(db, d.project.id));
" 2>/dev/null | tail -1)
echo "--- token: $TOKEN"
echo "--- public status JSON (no login):"; curl -s "localhost:4991/api/public/status/$TOKEN" | head -c 400; echo
echo "--- /status page (no login, expect 200):"; curl -s -o /dev/null -w "%{http_code}" "localhost:4991/status?token=$TOKEN"; echo
kill $SRV 2>/dev/null
rm -f /tmp/status-verify.sqlite*
