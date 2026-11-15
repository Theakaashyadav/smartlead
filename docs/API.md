# SmartLead API

Responses use `{ "data": ... }`; errors use `{ "error": { "code": "...", "message": "..." } }`. Mutations accept JSON. Session cookies authorize protected requests. Browser mutations are origin-checked; cross-site requests are rejected. No CORS access is granted. HTTP statuses include 400 validation, 401 sign-in required, 403 forbidden, 404 missing/inaccessible, 409 conflict, 410 expired capability, 429 rate limit, and 502 integration unavailable.

| Method | Endpoint | Access / behavior |
| --- | --- | --- |
| GET | /api/health | Database health, configured application origin and automation policy (`skipAlreadySentLeads: true`, `recipientLeadCounts: true`); failures return 503 with missing variable names and a safe diagnostic reason/code, never credentials, raw errors, or filesystem paths |
| GET | /api/simple/state | Administrator; connected sheets, recipients, sending counts and feedback-link readiness |
| GET | /api/simple/google | Administrator; credential labels, OAuth configuration status and expected redirect URI; no secrets |
| POST | /api/simple/google/authorize | Administrator; `{url,popup:true}` for a pasted sheet or `{sheetId,popup:true}` for an existing connection; returns the Google consent URL |
| POST | /api/simple/sheets/script | Administrator; {url} or {sheetId}; generate a private per-sheet Apps Script and expiring setup ID |
| POST | /api/simple/sheets/script/check | Administrator; {setupId,endpoint}; validate deployment, sheet identity and read/write access |
| POST | /api/simple/sheets/inspect | Administrator; `{url,credentialId}`; Google Sheets API inspection and Editor permission check |
| POST | /api/simple/sheets | Administrator; {scriptSetupId,spreadsheetId,worksheetId,columnMapping,project,sendFeedbackLink?}; consume a checked setup and create or upgrade the existing connection. The UI requires the project name; older API callers may omit it to retain the existing project or default to the sheet title. `sendFeedbackLink` defaults to true for new sheets; omission preserves an existing sheet's choice. Legacy credentialId input remains supported. |
| DELETE | /api/simple/sheets/:id | Administrator; immediately remove this organisation's sheet connection, dependent lead records, and queued or claimed jobs. No pause or idle-worker prerequisite. Workers stop remaining steps when the connection disappears; external requests already handed to WhatsApp or Google may still finish. The source spreadsheet, shared WhatsApp account, and other sheets are preserved. |
| PUT | /api/simple/sheets/:id/project | Administrator; {project,sendFeedbackLink?}; set the project name and optional feedback-link preference for this organisation's sheet and future/queued messages, without editing the Google Sheet or resending delivered messages |
| PUT | /api/simple/sheets/:id/feedback-link | Administrator; {sendFeedbackLink:boolean}; change the feedback-link switch for one sheet and refresh its queued messages immediately. Off omits both the feedback prompt and URL and does not require a public feedback endpoint. Existing sent messages and issued links remain valid. |
| POST | /api/simple/test-flow | Administrator; `{requestId,recipients:[{name,phone}],executiveNotificationPhone,notificationPhone}`; UUID request ID prevents duplicate submissions. Up to ten unique recipients, both notification numbers required; the same phone may be used for different roles. Requires connected WhatsApp and a ready worker. Queues a sample lead, executive notification, and administrator confirmation for each recipient without creating a sheet or lead. |
| GET | /api/simple/test-flow/:id | Administrator; organisation-scoped test progress with per-recipient `lead`, `executive`, and `owner` stages and separate submission receipts. Uncertain submissions stop the test and are never automatically resent. |
| PUT | /api/simple/sheets/:id/recipients | Administrator; ordered `{recipients:[{name,phone,leadCount}],executiveNotificationPhone?,notificationPhone?}`; `leadCount` is an integer from 1 to 1000 (default 1). Optional `executiveNotificationPhone` and `notificationPhone` are the executive's and administrator's WhatsApp numbers, normalized to E.164 and separate from the lead recipients. For each field, blank/null disables its notification; omission preserves its saved number. Reads the current sheet, requeues every unsent row in source order, and restarts consecutive-count rotation from the first selected recipient. Cleared Sent markers explicitly authorize resends while preserving prior delivery history. |
| POST | /api/simple/sheets/:id/writeback | Administrator; retry saved output updates for this organisation's sheet; immediately attempt the first waiting lead; never sends WhatsApp messages or resumes distribution |
| POST | /api/auth/login | `{email,password,code?}`; optional authenticator code |
| POST | /api/auth/logout | Revoke current session |
| GET | /api/auth/me | Current safe user profile |
| POST | /api/auth/reset-request | `{email}`; generic response, SMTP needed |
| POST | /api/auth/reset | `{token,password}`; single-use expiring token |
| PUT | /api/auth/password | `{currentPassword,password}`; invalidates other sessions |
| POST | /api/auth/totp | `{password}` to enroll; add `{secret,code}` to verify; `{disable:true,code}` to remove |
| GET | /api/workspace | Scoped dashboards, source/team summaries, recent leads |
| GET | /api/dashboard/overview | Same scoped summary |
| GET | /api/dashboard/sheets/:id | Scoped summary filtered to source |
| GET | /api/sheets | Visible source connections |
| POST | /api/sheets/inspect | Super Admin; `{spreadsheetId,credentialId?}`; readable tab names and headers |
| POST | /api/sheets/connect | Super Admin; source, mapping, and explicit managed-column approval |
| GET | /api/sheets/:id | Scoped source settings and recent sync logs |
| PUT | /api/sheets/:id/settings | Super Admin; cannot change source identity |
| POST | /api/sheets/:id/sync | Super Admin/assigned Manager; enqueue safe synchronization |
| PUT | /api/distribution/:sheetId | Super Admin/assigned Manager; mode, active recipients/weights, sender, template |
| GET | /api/leads | Paginated `{items,total,page,limit}`; max 100 per page |
| GET | /api/leads/:id | Scoped profile, feedback history, notification history |
| POST | /api/leads/assign | Manager; `{leadIds:[...],employeeId}`; max 100, authorized recipients only |
| POST | /api/leads/reassign | Manager; same input, revokes prior links and cancels eligible queued sends |
| POST | /api/leads/:id/feedback | Scoped owner/admin update; validated feedback and current version |
| POST | /api/leads/:id/feedback-link | Issue a short `/f/:token` 7-day private link for the primary assignment |
| POST | /api/leads/:id/writeback | Manager; retry managed output synchronization |
| GET | /api/feedback/:token | One authorized assignment only; expiring/revocable capability |
| POST | /api/feedback/:token | Validated feedback; atomic history/update/outbox transaction; responds after database commit, with Google Sheets syncing after the response |
| GET | /api/employees | Role-scoped recipients |
| POST | /api/employees | Super Admin; validated E.164 phone, capacity, optional executive login |
| PUT | /api/employees/:id | Super Admin; edit/deactivate employee and linked login |
| GET | /api/employees/:id | Scoped employee dashboard |
| GET/POST | /api/whatsapp | Super Admin; safe sender list / create provider account |
| POST | /api/whatsapp/:id/connect | Super Admin; worker initializes session |
| POST | /api/whatsapp/:id/disconnect | Super Admin; worker logs out |
| GET | /api/whatsapp/:id/qr | Super Admin; current QR/status only |
| GET | /api/whatsapp/:id/status | Super Admin; current safe connection state |
| GET/POST | /api/webhooks/whatsapp | Meta verification / HMAC-SHA256 authenticated provider events |
| GET | /api/notifications | Scoped latest 250 notifications, no body/session credentials |
| POST | /api/notifications/:id/retry | Manager; confirmed failed messages only, uncertain outcomes held |
| GET | /api/feedback-management | Scoped latest 250 feedback submissions |
| GET | /api/followups | Scoped latest 250 follow-up records |
| PUT | /api/followups/:id | `{completed:true}` or `{scheduledAt:ISO}`; preserve history, update lead/outbox |
| GET | /api/reports | Filtered report records, up to 10,000 |
| GET | /api/reports/export | `format=csv|xlsx|pdf`; same access and filters, export audit |
| PUT | /api/settings | Super Admin; `{name,timezone:"Asia/Kolkata",statuses:[...],sheetId?}` |
| GET/POST | /api/users | Super Admin; safe profiles / new manager or super administrator with sheet access |
| GET | /api/jobs | Super Admin; latest 100 pending/dead-letter/processing jobs |
| POST | /api/jobs/:id | Super Admin; explicit retry of dead-letter job |
| GET | /api/integrations/google/connect | Super Admin; OAuth redirect with optional `sheet` URL or `sheetId`; user/organisation-bound, expiring single-use state |
| GET | /api/integrations/google/callback | Super Admin; validate state, exchange code, encrypt offline credentials and check editing rights; popup flows return through `/google-complete`, redirects return to Sheets |
| GET | /api/events | Authenticated SSE refresh ticks; no customer data broadcast |

Lead/report/dashboard filters: `search`, `sheet`, `employee`, `project`, `status`, `messageStatus`, `from`, `to`. Dates accept ISO timestamps or calendar dates; calendar end dates include the whole day. Pagination: `page`, `limit`. Report types: `leads`, `sheets`, `employees`, `status`, `conversion`, `notifications`, `feedback`, `followups`.

Feedback example:

```json
{
  "status": "Interested",
  "remarks": "Customer requested the brochure. Follow up tomorrow.",
  "version": 1
}
```

A stale version returns 409; refresh the record and review the accepted update before retrying. Feedback can be saved successfully while sheet writeback remains pending/error. Repeated updates create feedback history, not duplicate leads.

New public links use `/f/` plus a 22-character random token. Existing signed `/feedback/` links remain valid until expiry or revocation. Public feedback exposes exactly eight statuses: `No Answer`, `Switch Off`, `Interested`, `Not Interested`, `Details Sent (Cold Client)`, `Followup (Hot Client)`, `Site Visit Scheduled`, and `Invalid no.`. The POST response includes the committed status, remark, new version, and `writebackStatus: "PENDING"` in `data.lead`; clients can acknowledge the save immediately. A durable WRITEBACK job retries failed sheet updates independently.

Live sheet connections use temporary lead storage by default. Confirmed sheet writes remove the completed lead, assignments, messages, feedback, follow-ups, lead audit records and associated jobs after any sent notification is accepted. A small expiring `FeedbackLink` retains only references, an encrypted source identifier, concurrency hashes/counters, and the original expiry. GET reads current lead details from Sheets without recreating database history; POST commits temporary feedback with no Google request, then verifies the source and writes in the background. Links remain reusable. Expiry never deletes pending feedback or uncertain deliveries. Sheet-level counts remain on the connection record so dashboard totals do not disappear after cleanup. `/api/health` reports this policy in `storage`.

For simple sheet connections, `GET /api/feedback/:token` includes `simple: true`, the sheet name, ordered source questions and answers, the current lead version and `writebackStatus`. The employee form submits only status, remarks and version. The worker writes **Sent Status**, **Shared To** (confirmed successful recipients), **Feedback** (lead status) and **Remark** to the same source identity. Authorized connections verify the API result before `writebackStatus` becomes `SYNCED`. Existing public connections require Apps Script for production writeback; connecting it preserves lead identities and sending history.

Simple imports save rows already marked **Sent** without assigning or sending them. Assignment and dispatch also block repeat sends using confirmed database history. Production dispatch verifies the current source marker before claiming the lead; unavailable, missing or ambiguous source rows hold submission. Concurrent queued messages for one lead are serialized through a shared lead update. Imported **Sent Status** and **Shared To** remain intact during feedback writeback even without a local provider receipt. Saving recipients performs a fresh source scan and explicitly reopens rows whose current Sent Status is not Sent, even when they have earlier successful submissions. It resets the rotation, revokes earlier feedback links for reopened rows, and queues them in source-row order. Previous receipts and feedback remain saved; the new send cycle alone determines Sent Status, Shared To, and administrator notifications. Clearing a marker during ordinary polling alone does not authorize resending. Other imported managed-cell edits continue to require conflict resolution.

After lead submission and a successful sheet write, the linked sender sends `New lead (Lead Name) shared to (Recipient Name).` to the configured executive number. Once that notification is accepted, it sends `New lead (Lead Name, Phone Number) shared to (Recipient Name) and executive also updated.` to the administrator number. Either notification can be disabled independently; without an executive number, the administrator message omits ` and executive also updated`. Notification settings and recipient names are captured when the lead is claimed for sending; edits apply to future sends, including queued leads. Sheet retries, later feedback and delivery receipts do not repeat notifications. Disconnections and confirmed rejections retry through the worker; an administrator retry does not repeat an accepted executive notification. Uncertain submissions are held for review, and an uncertain executive submission blocks the administrator confirmation. Errors appear in simple state as `sentNotificationError` and never alter lead send counts or resend the lead.

Demo-only endpoints: `POST /api/sheets/:id/demo-lead` inserts a fictional source row and processes the workflow; `GET /api/sheets/:id/source` reads that scoped durable source fixture. Demo providers are unavailable for new production connections.
