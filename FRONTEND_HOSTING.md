# Scanner Front-end Hosting Runbook

This project now supports **standalone front-end hosting** for scanner pages (`index.html`, `Reg2.html`, `Admin2.html`) while keeping Google Apps Script (`.gs`) as API/business-logic backend.

## 1) Host scanner front-end on camera-allowed HTTPS origin

Recommended hosts:
- Firebase Hosting
- Cloudflare Pages
- Netlify
- Any HTTPS domain you control

Deploy static front-end files and open the hosted URL directly (not in an iframe):
- `/scanner/index.html` (mobile scanner + handoff entry)
- `/index.html` (staff check-in)
- `/Reg2.html` (self service)
- `/Admin2.html` (admin)

### GitHub Pages option (default branch)

For this repo, enable Pages from **default branch** and use **`/(root)`** as source folder.

Resulting scanner URL format:

`https://<org-or-user>.github.io/CCF/scanner/`

The scanner supports two return paths:

- Classic portal: `postMessage` returns the result to the popup opener.
- Mobile portal: the scanner submits a same-tab HTTPS `POST` back to the Apps Script web-app URL. The QR payload is not placed in the URL. A one-time state value is matched before the portal processes the result.

The mobile return path requires both parts of the same release: deploy the updated Apps Script `Code.gs` and `index.html`, and publish the updated `scanner/index.html` and `scanner/scanner.js` on the configured scanner host.

## 2) Keep Apps Script as API backend

Business logic remains in `.gs` files. Front-end now supports 2 API modes:

1. **Legacy Apps Script UI mode** (existing):
   - Uses `google.script.run` automatically when no API endpoint is provided.
2. **Hosted front-end mode** (new):
   - Uses JSON RPC `POST` to Apps Script `doPost` endpoint when API endpoint is provided.

## 3) Connect hosted front-end to API endpoint

Set API endpoint using one of the following:

- Query parameter (quick test):
  - `https://your-host/index.html?api=https://<your-proxy-or-apps-script-web-app-url>`
- Global variable before app script runs:
  - `window.CCF_API_ENDPOINT = 'https://<your-proxy-or-apps-script-web-app-url>'`

JSON RPC payload format:
```json
{
  "fn": "api_staff_login",
  "args": ["<arg1>", "<arg2>"]
}
```

Response format:
```json
{ "ok": true, "result": { } }
```
or
```json
{ "ok": false, "error": { "message": "...", "name": "Error" } }
```

### CORS note
For browser calls from a different origin, use a thin proxy (recommended) if direct cross-origin POST to Apps Script is blocked by CORS.

## 4) Verify camera on new host

In browser console on the new hosted origin, run:

```js
navigator.mediaDevices.getUserMedia({ video: true })
```

Expected: permission prompt appears and Promise resolves to a `MediaStream`.

## 5) Rollout checklist for volunteers

1. Publish scanner URL on hosted domain.
2. Verify login + scan flow on iOS Safari and Android Chrome.
3. Share URL as temporary/primary check-in entry point.
4. Keep Apps Script URL as fallback.
5. Monitor first service and collect volunteer feedback.

<!-- ===== END OF FRONTEND_HOSTING.md (COMPLETE) ===== -->
