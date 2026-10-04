# October improvements — testing branch

Branch: `Oct-improvement`. Base: `main` at `c795cb2` (includes the live-login cache fix, PR #272).

**Do not merge or replace the live deployment before Justin has tested and approved this release.**

## What changes

- Separate mobile Live interface: four square home buttons, QR scan/upload, person search and confirmation, car lookup, attendance cards and serving list. The classic interface remains available. The PGCC logo is embedded locally; it does not depend on a Drive permission or image-hosting link.
- One-time, three-minute scanner-return tickets retain the authenticated session and event. The existing scanner's same-tab `POST` path is used; no opener is required. The QR key is never put in the return URL. Navigation handoffs expire after two minutes and can be consumed once.
- Mobile is an explicit opt-in from the stable classic portal. This preserves the current portal as the default while mobile device acceptance testing is completed; automatic browser-width routing is deliberately deferred.
- PGCC member-number display and input aliases. Persisted IDs, keys, relationships and spreadsheet headers remain CCF-based. Old CCF QR codes remain valid; newly generated QR images use PGCC with the same keys. External integrations reading raw sheets continue to see the original CCF IDs.
- Admin/GL service-planning entry replaces the old worship-planning and sermon-info menu entries. The member worship entry also opens the consolidated page. Sermon information, songs and serving assignments use existing records. Save/Cancel, unsaved-change prompts and revision checks protect edits. Existing permissions determine which sections can be edited; GL scope is preserved. Live users can read the plan; Staff/Deacon/Admin can open editing from More.
- Finance feature buttons are hidden. Existing finance records and the offering rota position are preserved.
- Non-Worship duplicate allocations can be overridden by GL/Staff/Deacon/Admin/Superuser within their existing edit scope. The user must review the member, date, existing and attempted positions, confirm explicitly and supply a reason of at least 10 characters. The existing `Admin_Activity` sheet records the exception. An attempted Worship assignment cannot use this override. Holiday, group-membership and young-volunteer restrictions remain enforced.
- Automatic sheet creation, column additions and legacy Vote/Serving layout migrations are blocked with `E_SCHEMA_APPROVAL`. No tabs or columns are added, renamed, deleted or reordered. Existing rows may be updated/appended by normal operations. Missing structures must be reviewed with Justin first.

Time, venue and announcements do not get new storage fields in this release. They require a separate decision if the current sheets do not already provide appropriate fields.

## Files in Apps Script

Update the existing backend files `Code.gs`, `Admin.gs`, `Reg.gs`, `Vote.gs` and existing HTML files `index`, `Admin2`, `Reg2`, `RotaPublic`, `Vote`, `VoteReview` from this branch.

Add:

| Apps Script file type | Name in the editor | Repository file |
|---|---|---|
| Script | `Pgcc` | `Pgcc.gs` |
| HTML | `LiveMobile` | `LiveMobile.html` |
| HTML | `ServicePlan` | `ServicePlan.html` |
| HTML | `PgccUi` | `PgccUi.html` |
| HTML | `PgccLogo` | `PgccLogo.html` |

Keep the complete contents, including template tags and end markers. `PgccLogo.html` contains a data URI, not a page to open directly. If your existing voting backend is named `VoteBackend.gs`, put the `Vote.gs` contents there; **do not create a second copy**. Its script filename does not change the `Vote` HTML template name.

The optional scanner change accepts an additional return-view name. Testing the new portal does **not** require publishing that scanner change: the new UI deliberately uses the already-supported `mobileScan` return format.

## Test deployment and rollback

1. Prefer a separate Apps Script project and a copy of the current workbook for testing. Set `SPREADSHEET_ID` in the test project's `Code.gs` to that copy. Review test email recipients and any existing triggers before submitting check-ins that send receipts. Do not change the production workbook.
2. Copy the complete branch files above. Preserve required existing Script Properties (including scanner configuration and authentication settings) in the test project.
3. Deploy a **new test web-app deployment**, retaining the current production deployment/version. Use its `/exec` URL for device testing; merely saving editor files does not update an existing versioned deployment. Confirm the scanner's return URL is the same test deployment.
4. Open `?mode=live-mobile` or choose **手機版 / Mobile interface** from the classic portal. `?mode=classic` provides the original interface. Service planning opens from a signed-in menu; a bare `?mode=service-plan` URL is not an authentication bypass.
5. Record any `E_SCHEMA_APPROVAL` detail; do not add a sheet/column to work around it without Justin's approval.
6. Roll back testing by returning to the retained production URL/version. No data migration or prefix conversion needs reversing. Test data edits remain in the test workbook.

## Validation

Local results: **69 backend/regression tests passed**. Chromium smoke checks passed at 320, 390 and 430px. Backend and inline frontend scripts also passed syntax checks. Real deployed Apps Script and camera testing remains outstanding.

Automated backend/regression tests: `node --test tests/*.test.mjs`.

Browser smoke tests (mocked Apps Script API): install Playwright and Chromium, then run `node tests/mobile-ui.smoke.mjs`. An existing Chromium executable can be supplied using `PGCC_CHROMIUM_PATH`. The script exercises 320/390/430px layouts, person selection, car results, attendance filtering, QR image handling, scanner navigation, planning saves and stale-edit handling.

Before approval, test the deployed Apps Script project on an iPhone/Safari and Android/Chrome, including:

- QR login, check-in, cancellation, camera permission denial, upload and expired scanner return; test within WhatsApp's browser as well as the normal browser.
- Mobile/classic switching while signed in; no horizontal scrolling or clipped controls.
- Manual person confirmation, already-checked-in results, car lookup, live attendance refresh and serving display.
- Admin/Deacon/Staff/GL permissions, non-Worship override reason/audit, blocked Worship override and holiday conflicts.
- Service planning edits, cancellation and two simultaneous editors; confirm updates appear in the original service-info/rota/bulletin sources.
- Old CCF QR and new PGCC QR login; PGCC member-number search; existing sheet names, headers and order unchanged.

Local mocks cannot validate real camera permissions, Apps Script deployment/iframe behavior, Google account access or production latency. Those remain acceptance checks before merging.
