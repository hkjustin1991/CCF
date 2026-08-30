# CCF Portal System — Handover for Codex/Git (Feb 2026)

You’re taking over development in Codex + Git. Some earlier chat outputs violated our own rules (functions dropped, UI changed without request, wrong assumptions from logs). This handover resets the **source of truth** and lists **non-negotiables**, **current repo state**, and **next implementation steps**.

---

## 0) Repo state (what exists in Git now)

Current tracked versions you stated:

- **Reg/Self-service portal:** `2026-01-31.reg2`
- **Admin portal:** `v2026-01-27.admin4`
- **Staff portal:** `staff8` (to be rebranded as **Live Service Portal**)

**Rule:** start from these files as truth. Preserve existing endpoints + UI unless explicitly changed below.

---

## 1) Non-negotiables (“critical rules”)

1) **Preserve all current functions + displays** in `reg2`, `admin4`, `staff8`  
   - Do NOT delete/rename endpoints or UI features “because out of scope” unless explicitly requested.
   - Rebranding text is fine; removing a button/function is not unless requested.

2) **English-only coding + sheet keys**
   - No Chinese identifiers in code/sheets.
   - UI display can be bilingual.

3) **Every .gs / .html must end with an explicit END MARKER**
   - Purpose: detect truncation/timeouts when working via LLM.
   - Format example (use consistently):
     - `/* ===== END OF Code.gs (COMPLETE) ===== */`
     - `<!-- ===== END OF index.html (COMPLETE) ===== -->`

4) **Do not infer member status / group membership from Checkins logs**
   - Checkins is an activity log. Authority comes from **Members** (and serving membership data).

---

## 2) Portals (3) — roles & scope

### A) Live Service Portal (formerly “Staff Portal”)
**Scope shown on UI (ONLY these tabs):**
- Check-in
- Live (includes “who is serving today” + check-in reminder/prompt)
- VRM
- Self-check (2 buttons only)

**But:** all existing functions already in `staff8` must remain (including authorise function).  
If something exists in staff8, keep it unless we explicitly remove later.

### B) Admin Portal
Admin remains the “back office”:
- Attendance/stats (already implemented in admin4)
- Member status changes (already implemented in admin4)
- Serving management UI + manual assignment/search (new work, but should not break existing admin4)
- GL access: serving-only mode (other admin buttons greyed)

### C) Self Service / Reg Portal
- Entry after QR login
- Menu: view/change details, **service signup/view**, attendance stats (self)
- **Serving beta**: currently restricted to staff-level users only (can expand later)

---

## 3) Terminology: statuses vs roles vs group leadership

### Member `Status` (existing concept)
Keep these as-is:
- ADMIN, STAFF, HELPER, TEMP, ACTIVE, PENDING, PROVISIONAL, DISABLED

### Expiry rules (explicit)
- **TEMP** expiry: **2 days** (unchanged)
- **HELPER** expiry: **31 days** (CHANGED from 7)

### New concept: **GL = Group Leader** (NOT a Status)
GL is a **role flag**, not a new Status.
- A GL might be ACTIVE (not STAFF/DEACON/ADMIN).
- If someone is already STAFF/DEACON/ADMIN, that “trumps” GL.

GL access:
- **Admin portal:** access only the serving functions (other buttons disabled)
- **Live Service Portal:** access to **Live tab** (and check-in if granted by status rules below)

New authority rule:
- **HELPER can now only be authorised from Admin Portal** by:
  - STAFF/DEACON/ADMIN, OR
  - a **GL** from the allowed group(s) that support worship functions (see §6)

---

## 4) Serving system — group codes and display names

### Group keys in sheet/code (short, English)
Use these **short keys** in sheets and code for easier manual editing:
- `MEDIA`
- `WORSHIP`
- `LOGISTIC`
- `SUPPORT`
- `FINANCE`

### Group English display (longer) + Chinese display (UI only)
Map for UI rendering:
- MEDIA: “Media — Media Master” / “影像大師”
- WORSHIP: “Worship — Worship Alliance” / “敬拜聯盟”
- LOGISTIC: “Logistic — Logistic Specialist” / “後勤特工”
- SUPPORT: “Support — Divine Supporter” / “聖工支援隊”
- FINANCE: “Finance — Finance Dept” / “財務公司”

> Note: earlier chat mentioned `Media_Master` etc. We standardise to **short keys** above for sheets/code, and use mapping for display.

---

## 5) Serving rules (business logic)

Service time window (FYI for UI text):
- Sundays, start time **12:30 or 13:30**, end by **15:00 latest**

### Eligibility
- A member can only self-sign-up for positions **within their own serving group(s)**.
- Group leaders (GL) can manage only their group scope (unless STAFF/DEACON/ADMIN).

### Per-event limits
Default:
- Self-sign-up: **max 1 position per eventKey** per person.

Override (Admin/GL):
- STAFF/DEACON/ADMIN/GL can manually assign **up to 2 jobs per eventKey**,
  - **EXCEPT**: if the person is assigned any **WORSHIP** position for that eventKey → they cannot have any other position (inside or outside WORSHIP) for that eventKey.

WORSHIP special rule (clarified):
- WORSHIP members *may* serve in other groups **only if** they are **NOT** serving in a WORSHIP position for that specific service.
- If they are serving in WORSHIP that week → **hard block** any additional positions.

### Cutoffs
- Members can self change/cancel until **4 weeks before** service date.
- After 4-week cutoff:
  - They can still self sign-up (if slot available),
  - But UI must warn “sure?” and tell them **contact GL for changes/cancellation**.
- GL/STAFF/DEACON/ADMIN can edit rota up to last minute and even retroactively.
- Rota entries expire **day +1** after service date (still viewable historically if you choose; business rule says “rota only expire day+1”).

### Visibility windows
- Public (any non-DISABLED member): view rota **2 weeks** in advance.
- Group members: view all positions **4 weeks** in advance.
- UI optimisation: for dates >4 weeks ahead, show only **eligible positions** to reduce clutter.

### Notifications
- Email reminders to signed-up members:
  - **2 weeks before** service
  - **1 day before** service

### Welcome (“招待”) auto access rule
- People assigned to Welcome positions must get at least **TEMP** access for check-in if they don’t already have higher privileges.
- Implementation recommendation: when Admin assigns a Welcome role (or at “publish rota”), automatically set:
  - `Status = TEMP`
  - `RoleExpires = now + 2 days`
  - unless already STAFF/DEACON/ADMIN/HELPER/TEMP

---

## 6) GL authority scope (HELPER authorisation)

HELPER (31 days) can only be granted via **Admin portal** by:
- STAFF/DEACON/ADMIN, OR
- GL from allowed group(s) that “support worship functions”

Practical default (safe + matches ops):
- Allowed GL groups to grant HELPER: `MEDIA`, `LOGISTIC`, `SUPPORT`, `WORSHIP`
- Not allowed: `FINANCE` (unless later requested)

Also limit GL-granted HELPER:
- GL can grant HELPER **only to members within their own group** (or only for Welcome team if LOGISTIC GL).  
  STAFF/DEACON/ADMIN can grant across groups.

---

## 7) Data model (sheets/columns) — minimal and staff-friendly

### Members sheet (existing headers)
Existing first 11 headers must remain unchanged:
`FamilyID, MemberLetter, ID, Key, NameZh, NameEn, Email, Mobile, Status, OptOutEmail, Notes`

Existing optional columns already used in code:
- VRM, VRM2
- RoleExpires / RoleExpiresISO (pick ONE canonical, but keep backwards compatibility)
- PreferredName
- IsMinor
- Member_Since (admin portal uses it)

**Add 2 new optional columns (preferred approach: store group/GL here to avoid extra sheets):**
- `ServingGroups`  (CSV: `MEDIA,LOGISTIC`)
- `ServingGLGroups` (CSV: `LOGISTIC`)

> This avoids “too many sheets” and supports filtering/search in Admin portal.

### Serving sheet (rota) — `Serving`
Used by:
- Admin portal: full CRUD
- Live Service Portal: read-only “serving today”
- Self service: signup/view

Recommended columns (order-insensitive):
- `EventKey` (SundayService_YYYY-MM-DD)
- `Group` (short key: MEDIA/WORSHIP/LOGISTIC/SUPPORT/FINANCE)
- `Position` (short key; e.g. WELCOME, PPT, PIANO, USHER, PRAYER etc)
- `Slot` (string or number; keep manual-edit friendly)
- `MemberId` (CCF####)
- `Source` (SELF / ADMIN / GL)
- `UpdatedAt`
- `UpdatedBy` (actor ID)

### Serving positions config (optional but helps validation/UI)
If you want a single config sheet (recommended):
- `Serving_Positions`
  - Group, Position, DisplayEn, DisplayZh, MaxSlots, AllowsSelfSignup (Y/N)

This can be introduced later; beta can hardcode minimal mapping first.

---

## 8) Live Service Portal specific UI requirements

### Live tab must show
- Today’s `eventKey`
- Live check-in list
- **Serving today list** pulled from `Serving` sheet filtered by today’s eventKey
- For each serving row: show checked-in boolean by comparing MemberId to today’s check-in set

### Check-in prompt text change
If no one checked in yet:
- Show: `OK sign, please welcome and check in the first person`
(Replace prior “Check-in has not started / 尚未開始簽到”)

### Self-check messaging (beta)
Self-check text should be short:
- “Back-end checks only. Some forward functions may still be problematic. Feedback to Media team appreciated.”
Use same beta message copy/paste where needed.

---

## 9) Authorisation feature (must be preserved)

Existing two-scan workflow stays:
- scan target QR
- scan approver QR (STAFF/DEACON/ADMIN, or SUPERUSER rules as implemented)

Do not remove:
- validation endpoints
- UI flows
- audit logs

Only adjust expiry constants:
- TEMP = 2 days (unchanged)
- HELPER = 31 days (new), and HELPER grant must be routed through Admin portal logic (GL allowed per §6)

---

## 10) What NOT to do (common past mistakes)

- Don’t “simplify” by deleting menus/functions without explicit request.
- Don’t assume a person’s group/role from the Checkins log.
- Don’t use Chinese in code/sheet keys.
- Don’t forget END MARKERS.

---

## 11) Immediate tasks for Codex (recommended sequence)

1) **Create HANDOVER.md** (this file) + add END MARKERS standard.
2) In `staff8`:
   - Rebrand titles to “Live Service Portal”
   - Ensure Live tab includes `Serving today` read-only list
   - Ensure check-in prompt text logic is updated
   - Keep all existing endpoints (including authorise)
3) In `admin4`:
   - Add `ServingGroups` + `ServingGLGroups` handling (read/filter)
   - Implement serving-only UI mode for GL
   - Implement HELPER(31 days) grant rules (STAFF/DEACON/ADMIN or GL per group)
4) Add/confirm `Serving` sheet schema + read/write helpers.
5) Add scheduled email reminders (2 weeks + 1 day) — can be a later milestone.

---

## 12) Quick test checklist (manual)

- Live portal login:
  - STAFF/DEACON/ADMIN works
  - HELPER/TEMP works only if RoleExpires valid
  - GL (ACTIVE + ServingGLGroups set) can access allowed views (per design)
- Check-in scan:
  - Dedup works (same member same eventKey returns ALREADY)
  - First person prompt shows correctly when empty
- Live tab:
  - Serving today appears
  - checkedIn flag reflects checkins
- Authorise:
  - target + approver scans still function
- Admin portal:
  - STAFF/DEACON/ADMIN full features unchanged
  - GL sees serving-only mode
  - HELPER grant sets expiry 31 days

---

## END MARKER STANDARD
Add to every file:
- .gs: `/* ===== END OF <FileName> (COMPLETE) ===== */`
- .html: `<!-- ===== END OF <FileName> (COMPLETE) ===== -->`
