# SmartLead API

Responses use `{ "data": ... }`; errors use `{ "error": { "code": "...", "message": "..." } }`. Mutations accept JSON. Session cookies authorize protected requests. Browser mutations are origin-checked; cross-site requests are rejected. No CORS access is granted. HTTP statuses include 400 validation, 401 sign-in required, 403 forbidden, 404 missing/inaccessible, 409 conflict, 410 expired capability, 429 rate limit, and 502 integration unavailable.

| Method | Endpoint | Access / behavior |
| --- | --- | --- |
| GET | /api/health | Database health and configured application origin; failures return 503 with missing variable names and a safe diagnostic reason/code, never credentials, raw errors, or filesystem paths |
| GET | /api/simple/state | Administrator; connected sheets, recipients, sending counts and feedback-link readiness |
| GET | /api/simple/google | Administrator; credential labels, OAuth configuration status and expected redirect URI; no secrets |
| POST | /api/simple/google/authorize | Administrator; `{url,popup:true}` for a pasted sheet or `{sheetId,popup:true}` for an existing connection; returns the Google consent URL |
| POST | /api/simple/sheets/script | Administrator; {url} or {sheetId}; generate a private per-sheet Apps Script and expiring setup ID |
| POST | /api/simple/sheets/script/check | Administrator; {setupId,endpoint}; validate deployment, sheet identity and read/write access |
| POST | /api/simple/sheets/inspect | Administrator; `{url,credentialId}`; Google Sheets API inspection and Editor permission check |
| POST | /api/simple/sheets | Administrator; {scriptSetupId,spreadsheetId,worksheetId,columnMapping}; consume a checked setup and create or upgrade the existing connection. Legacy credentialId input remains supported. |
| PUT | /api/simple/sheets/:id/recipients | Administrator; ordered `{recipients:[{name,phone}]}`; starts round-robin sending |
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
| POST | /api/leads/:id/feedback-link | Issue a signed 7-day link for the primary assignment |
| POST | /api/leads/:id/writeback | Manager; retry managed output synchronization |
| GET | /api/feedback/:token | One authorized assignment only; expiring/revocable capability |
| POST | /api/feedback/:token | Validated feedback; atomic history/update/outbox transaction |
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

For simple sheet connections, `GET /api/feedback/:token` includes `simple: true`, the sheet name, ordered source questions and answers, the current lead version and `writebackStatus`. The employee form submits only status, remarks and version. The worker writes **Sent Status**, **Shared To** (confirmed successful recipients), **Feedback** (lead status) and **Remark** to the same source identity. Authorized connections verify the API result before `writebackStatus` becomes `SYNCED`. Existing public connections require Apps Script for production writeback; connecting it preserves lead identities and sending history.

Demo-only endpoints: `POST /api/sheets/:id/demo-lead` inserts a fictional source row and processes the workflow; `GET /api/sheets/:id/source` reads that scoped durable source fixture. Demo providers are unavailable for new production connections.
