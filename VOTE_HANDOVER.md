# Reusable CCF QR Polling Portal — Operating Guide

The member portal is available at `?mode=vote`. It reuses the existing CCF member QR and member register. Routine poll creation, the not-eligible list, voting and aggregate results are handled in the portal.

The rota Google Sheet may be shared separately for member editing and Google version history. Do not give general members access to the CCF system spreadsheet or its `Vote` tab.

## Apps Script file names

Apps Script does not allow two project files with the same base name. Use these project file names:

| Repository file | Apps Script project file |
|---|---|
| `Vote.gs` | `VoteBackend.gs` |
| `Vote.html` | `Vote.html` |
| `VoteReview.html` | `VoteReview.html` |

Renaming `Vote.gs` to `VoteBackend.gs` in Apps Script requires no code changes. Apps Script loads all `.gs` files into the same server-side namespace.

## What is shown before sign-in

The public page displays only the current poll question and the two QR sign-in methods. It does not return or display:

- poll options;
- the poll ID, state, dates or response mode;
- ballot totals; or
- aggregate results.

Selecting a QR image starts decoding immediately. A member does not need an ADMIN role to sign in or vote.

## Roles

| Action | Eligible member | STAFF | DEACON / ADMIN | Appointed scrutineer |
|---|---:|---:|---:|---:|
| Submit once per poll | Yes | Yes | Yes | Yes |
| Add/remove a poll-specific exclusion | No | Yes | Yes | Only if also STAFF/DEACON/ADMIN |
| Create/edit polls, including whether all children are included | No | No | Yes | No |
| Open and close polls | No | No | Yes | No |
| Appoint/remove scrutineers | No | No | Yes | No |
| View results before closing | No | Only if appointed | Yes | Yes |
| Use the separately routed review workflow | No | Only if appointed | Yes | Yes |

DEACON has the same poll-management authority as ADMIN. There is no software limit on appointed scrutineers; appoint each person by exact CCF ID for the relevant poll.

## Eligibility

A member may cast a ballot unless any of these applies:

- `Status` is blank, `DISABLED`, `PROVISIONAL` or `PENDING`;
- `IsMinor=YES` and the poll-wide **Include all child members** box is off; or
- STAFF/DEACON/ADMIN has placed the member on that poll's not-eligible list and entered a reason.

There are no per-child approval boxes. One setting includes or excludes all children for that poll. A named exclusion still overrides the poll-wide setting. An expired privileged role is treated as `ACTIVE`, so an expired STAFF/DEACON/ADMIN role does not retain management access.

## One-time setup and the two voting tabs

1. Copy `Vote.gs` into an Apps Script script file named `VoteBackend.gs`.
2. Copy `Vote.html` and `VoteReview.html` into HTML files with those exact names.
3. Deploy the version containing the `mode=vote` route.
4. Open the deployed web-app URL with `?mode=vote`.
5. A DEACON or ADMIN signs in with their own CCF QR and selects **開始 / Start**.

The finished spreadsheet has only these two voting tabs:

- `Vote`: poll questions, options, response settings, dates, and blank `FinalResult` / `ResultNotes` fields for entering the agreed result after the poll is finished.
- `Vote Audit`: the not-eligible list, ballots, appointed scrutineers, and the running system log.

If `Vote` already exists from the previous release, setup adds only one new tab, `Vote Audit`. It copies and verifies the running records there before removing those rows and unused columns from `Vote`.

If the older six `Vote_*` tabs exist, setup routes every row into `Vote` or `Vote Audit`, verifies every copied source row, and only then removes those six legacy tabs. A fresh installation creates both voting tabs.

All unrelated spreadsheet tabs are left untouched. Setup also preserves the existing private Script Property. If that property is missing while ballots exist, the system refuses to generate a replacement.

## Create a poll

After DEACON/ADMIN sign-in, choose **管理投票 / Manage polls**. The small `+` button at the top right opens the create page.

1. Enter the question in the single question box.
2. Enter the first two options.
3. Use the small `+` beside **Options** to add more.
4. Leave **Allow multiple choices** off for a one-choice poll.
5. Turn it on for a multiple-choice poll and set the maximum selections.
6. Turn on **Record choice order** when order matters.
7. Tick **Include all child members** if every child member should be able to take part.
8. Create the poll. It is saved as `DRAFT`.
9. Add any named exceptions to **Not eligible list**.
10. Appoint scrutineers by exact CCF ID.
11. Set opening and closing times, then change the state to `OPEN`.

Every open ballot form also has a separate **棄權 / Abstain** button. Abstention is recorded as a valid ballot and reported separately.

For ordered polls, the portal stores the submitted option order. It deliberately does not apply a winner or points method. Scrutineers decide the method outside the system before processing the stored orders.

## Member experience

- Ordinary members see the current poll immediately after QR sign-in.
- DEACON/ADMIN first see two choices: **Cast vote** or **Manage polls**.
- STAFF first see **Cast vote** or **Not eligible list**.
- The casting page contains the current question and ballot only; it has no eligibility panel or management button.
- A member may submit only once per poll.
- The final confirmation cannot be changed after submission.
- The receipt page contains a receipt ID and submission time.
- Signing in again returns the original receipt instead of adding another ballot.

The technical limit is one submission per CCF ID. Check the member register for duplicate valid IDs belonging to one person before opening a formal poll.

## Response modes and results

| Mode | Ballot behavior | Aggregate result behavior |
|---|---|---|
| `SINGLE` | Exactly one option, or Abstain | One count for the selected option |
| `MULTIPLE` | One or more options up to the configured maximum, or Abstain | Each selected option receives one count; total ballots remains the number of submissions |
| `RANKED` | One or more unique options stored in submitted order, or Abstain | Ballot and abstention totals only; no automatic ranking |

Ordinary members cannot view totals before the poll closes. DEACON, ADMIN and appointed scrutineers may view them earlier. Once the current poll is closed, signed-in members may view its final aggregate result.

## Poll lifecycle

- `DRAFT`: the question, mode and options may be edited while there are no ballots.
- `OPEN`: ballot content is locked. A future opening time appears as `SCHEDULED`.
- `CLOSED`: final and cannot be reopened.
- An open or scheduled current poll must be closed before another poll can replace it.
- Creating a draft does not displace an active current poll.
- Previous polls remain in the manager.

The option set is protected by a digest. Manual changes to option records make the poll unavailable instead of silently changing an active ballot.

## Separately routed review workflow

There is no link or description for this workflow in the ordinary portal. Keep the route within restricted operator material:

`?mode=vote-review`

An ADMIN or a scrutineer appointed to the relevant poll must sign in, enter a receipt ID and give a specific reason of at least 10 characters. The system writes the operator, poll, receipt and reason before displaying the matched member and recorded response. If that write fails, member details are not displayed.

## Acceptance check before sharing the link

- Confirm the signed-out page shows only the current question and QR sign-in controls.
- Confirm QR-image selection starts automatically and no `E415` image error remains.
- Confirm an `ACTIVE` adult reaches the open poll, including a non-admin test member.
- Confirm `DISABLED`, `PROVISIONAL`, `PENDING` and blank-status accounts are blocked.
- Confirm all children are blocked when **Include all child members** is off and allowed when it is on.
- Confirm a poll-specific named exclusion still blocks that member.
- Confirm single, multiple, ordered and Abstain submissions behave as configured.
- Confirm a second submission returns the original receipt and adds no ballot row.
- Confirm ordinary members cannot view live totals.
- Confirm DEACON, ADMIN and appointed scrutineers can view live totals.
- Confirm an ordered poll shows no calculated ranking.
- Confirm the spreadsheet contains `Vote` and `Vote Audit`, with no legacy `Vote_*` tabs after successful setup.
- Confirm `Vote` contains only poll/configuration rows and has `FinalResult` and `ResultNotes` columns.
- Confirm `Vote Audit` contains ballots and running records.
- Confirm previous polls remain available in the manager.
- Confirm QR sign-in and QR-image upload on both iPhone and Android.

<!-- ===== END OF VOTE_HANDOVER.md (COMPLETE) ===== -->
