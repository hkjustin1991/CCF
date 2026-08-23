# Reusable CCF QR Polling Portal — Operating Guide

The polling portal is available at `?mode=vote`. It reuses the existing CCF member QR and member register. Routine operation is completed through the portal; the next operator should not need to edit Apps Script or the `Vote_*` tabs.

The rota Google Sheet may be shared separately for member editing and Google edit history. Do not give general members access to the CCF system spreadsheet or its `Vote_*` tabs.

## What members see

The ordinary member flow contains only:

- the current poll title and dates;
- the member's eligibility;
- one-choice ballot options when the poll is open;
- final submission confirmation; and
- a receipt ID after submission.

Do not add descriptions of internal exception-review mechanics anywhere in the normal polling portal. The exceptional workflow belongs only on its separate, unlinked, restricted route.

## Roles

| Action | Member | STAFF | DEACON / ADMIN | Appointed scrutineer |
|---|---:|---:|---:|---:|
| Submit one response per poll | Yes, if eligible | Yes, if eligible | Yes, if eligible | Yes, if eligible |
| Tick child eligibility for the current poll | No | Yes | Yes | Only if also STAFF/DEACON/ADMIN |
| Add/remove a poll-specific exclusion | No | Yes | Yes | Only if also STAFF/DEACON/ADMIN |
| Create and edit a draft poll | No | No | Yes | No |
| Set the current poll and open/close it | No | No | Yes | No |
| Appoint/remove scrutineers | No | No | Yes | No |
| View results before closing | No | Only if appointed | Yes | Yes |
| Use exceptional ballot review | No | Only if appointed | Yes | Yes |

There is no software limit on appointed scrutineers. Add each person by exact CCF ID for the relevant poll. At least two scrutineers are recommended for a formal vote.

## Eligibility

A member is eligible unless any of these applies:

- `Status` is blank, `DISABLED`, `PROVISIONAL`, or `PENDING`;
- `IsMinor=YES` and STAFF/DEACON/ADMIN has not ticked child eligibility for that poll; or
- STAFF/DEACON/ADMIN has placed the member on that poll's not-eligible list and entered a reason.

An explicit exclusion overrides a child-eligibility tick. An expired privileged role is treated as `ACTIVE`, so an expired STAFF/DEACON/ADMIN role does not retain management access.

## One-time system setup

1. Deploy the Apps Script version containing `Vote.gs`, `Vote.html`, and the `mode=vote` route.
2. Open the deployed web-app URL with `?mode=vote`.
3. A DEACON or ADMIN signs in with their own CCF QR.
4. Select **初始化投票系統 / Initialise polling system** once.
5. The portal opens the ADMIN poll-creation form.

Initialisation creates the six `Vote_*` tabs and one private Script Property used by ballot integrity and the exceptional review process. If the system has already been initialised, the ADMIN goes directly to the normal dashboard.

## Create a poll in the ADMIN page

1. Sign in with a DEACON or ADMIN QR.
2. Select **建立新投票 / Create poll**.
3. Enter a Chinese title, an English title, or both.
4. Enter between 2 and 50 options. Each option needs a unique short number/code and at least one Chinese or English label.
5. For the present church-name vote, select **載入教會名稱選項 / Load church-name choices** to load the approved 13-name list, then check it before saving.
6. Select **建立投票 / Create poll**. It is saved as `DRAFT`.
7. In **投票資格 / Eligibility**, tick each eligible child and add any poll-specific exclusions with reasons.
8. In **監票員 / Scrutineers**, add every appointed scrutineer by exact CCF ID.
9. Check the member register for duplicate valid CCF IDs belonging to one person. The technical limit is one submission per CCF ID.
10. Agree any tie procedure before opening.
11. Enter the opening and closing times. Change the state to `OPEN` to open immediately or schedule it for the opening time.

The public member page displays one current poll. Creating a new draft makes it current when no existing poll is open or scheduled. If a current poll is active, the new poll remains saved in the manager without displacing it.

## Poll manager and repeat use

Use **投票管理 / Poll manager** to:

- create another poll;
- view current and previous polls;
- edit a draft's title and options;
- set a non-active poll as current;
- manage poll-specific eligibility and scrutineers; and
- view results for a previous poll without making it current.

Lifecycle rules:

- `DRAFT`: title and options may be edited while there are no ballots.
- `OPEN`: options are locked. A future opening time appears as `SCHEDULED`.
- `CLOSED`: final and cannot be reopened.
- An open or scheduled current poll must be closed before another poll can replace it.
- Previous polls and their records remain available in the poll manager.

The option set is protected by an integrity digest. Manual changes to `Vote_Options` will make the poll unavailable rather than silently changing an active ballot.

## Member submission flow

1. Open `?mode=vote` and choose **External scanner** or **Upload QR image**.
2. Sign in using the member's own CCF QR.
3. If eligible and the poll is open, select exactly one option.
4. Review the selected option and tick the final-choice acknowledgement.
5. Submit. The response cannot be changed and a second response for that poll is refused.
6. Save the receipt ID if desired. Signing in again shows the same receipt instead of another ballot.

The raw QR payload and QR key are not written to any `Vote_*` tab or audit entry.

## Results

- Totals are not returned to ordinary members while voting is open or scheduled.
- ADMIN and the poll's appointed scrutineers may view totals before closing.
- Once the current poll closes, signed-in members may view its final totals.
- Authorised operators can view previous results through the poll manager.
- Invalid or manually altered ballot rows are excluded from valid totals. Authorised reviewers see the number of integrity exceptions.

## Exceptional ballot review

There is no link, wording, or control for this process in the normal `?mode=vote` portal. Keep the separate route within this restricted handover material and supply it to an authorised operator only when a real exception occurs:

`?mode=vote-review`

1. An ADMIN or a scrutineer appointed to the relevant poll opens the restricted route.
2. Sign in with that operator's own CCF QR.
3. Select the relevant poll.
4. Enter the receipt ID and a specific reason of at least 10 characters.
5. Confirm the warning.
6. The system first writes an audit entry. Only after that succeeds does it display the matched member and choice.

Do not use this control for curiosity checks. If the audit write fails, the system reveals nothing.

## Data and recovery rules

- Do not manually edit `Vote_Ballots`, `Vote_Audit`, `Vote_Options`, or `Vote_Elections`.
- Do not delete or rotate the private polling Script Property. If it is missing after ballots exist, the portal refuses to generate a replacement.
- If a ballot row is missing but its cast audit remains, that member is blocked from submitting again and an integrity error is raised.
- Use Google Sheet version history for accidental Sheet changes.
- Keep the portal deployment and CCF system spreadsheet limited to existing trusted operators.

## Acceptance check before sharing the link

- Confirm an `ACTIVE` adult reaches the current open poll.
- Confirm `DISABLED`, `PROVISIONAL`, `PENDING`, and blank-status accounts are blocked.
- Confirm an unticked child is blocked and becomes eligible after STAFF/DEACON/ADMIN ticks the child for that poll.
- Confirm a poll-specific exclusion overrides eligibility.
- Confirm the ballot uses radio buttons and permits exactly one option.
- Confirm a second submission returns the original receipt and adds no ballot row.
- Confirm the member register has no duplicate valid ID for one person and record the tie procedure.
- Confirm an ordinary member cannot view live totals.
- Confirm DEACON, ADMIN and every appointed scrutineer can view live totals, and a non-appointed STAFF member cannot.
- Confirm a draft can be created for the next poll without replacing an active current poll.
- Confirm previous polls remain available in the manager.
- Confirm exceptional review rejects a missing/short reason and reveals nothing if its audit write fails.
- Confirm external scanner and QR-image upload on both iPhone and Android.

<!-- ===== END OF VOTE_HANDOVER.md (COMPLETE) ===== -->
