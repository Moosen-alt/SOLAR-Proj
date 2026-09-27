# Public official form fixtures

These blank government forms contain no customer data. Source links were checked against the authorities' forms pages during the September 2026 continuation. Hashes and exact-revision maps are in `backend/src/curatedAhjForms.ts`.

- `tigard-building.pdf`: https://www.tigard-or.gov/home/showpublisheddocument/42/639007759919470000 — four pages; application on page 3, printed footer 01/25/2023.
- `tigard-electrical.pdf`: https://www.tigard-or.gov/home/showpublisheddocument/44/637615268530600000 — two pages, Rev 06/17/2015.
- `coos-electrical.pdf`: https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf — one page, Revised 2025 (no month/day stated).

- `marion-b-01s.pdf`: https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf — Marion County's prescriptive solar PV application, five pages (application on page 1, OSSC sections after), fillable, no printed revision date. SHA-256 8c8daff4239868c9a156bcabf6e6690eb3677541b24c34ca7eec59bb8bd0a732. The URL the per-job lookup for City of Jefferson cited.
- `marion-e-01.pdf`: https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf — Marion County's Renewable Electrical Energy Permit Application, one page, fillable, footer "06/20". SHA-256 bd723dfa527a18990d40ce9871ae20a8a31e5d9e85a383db610d69ed027948a4. Found on the county's "Applications, Forms, and Brochures" listing.

Both Marion blanks were fetched ONCE each on 2026-09-27 through the product's own retrieval path (documentFetch.fetchPublicDocument, plain HTTP 200), 12 s apart; the fetch log is kept outside the repo in `.probe/agency-apps/live-fetch/fetch-log.json`. They are keyed to the ISSUING agency (Marion County), never to a city it issues for.

Discovery pages: https://www.tigard-or.gov/your-government/departments/community-development/permit-center/forms/-folder-23 and https://co.coos.or.us/how-to-submit-a-permit-permit-applications. Coos Bay's building permit page identifies Coos County as the electrical permitting authority.

The Tigard forms still print historical fees. These are preserved as source content, never imported as current fee quotes or paid amounts. Maps leave unknown facts, fee totals, owner attestations, and signatures blank for review. They remain unverified until an operator approves them. A changed source revision requires a new map.
