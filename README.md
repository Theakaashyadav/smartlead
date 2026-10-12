# SmartLead

A simple Google Sheets → WhatsApp lead sender. Log in, connect multiple sheets, link one WhatsApp Web account, and choose recipients for each sheet. Leads go to one selected person at a time in order, then repeat.

## Separate organisations

Use **Create an account** on the login page (or `/register`) for each organisation. Enter your name, organisation name, email, and a password of at least 12 characters. Your email is your login ID. Each registration opens an empty workspace with its own WhatsApp connection, Google Sheets, contacts, recipients, leads, credentials, settings, and job history. Administrators can access only their own organisation. Users added through the team API belong to the inviting administrator's organisation; use registration for an independent organisation.

Your existing account, sheets, WhatsApp session, and lead history stay in the original organisation. To upgrade an existing SQLite installation, run `npm run db:upgrade-organizations`, `npm run db:generate`, then `npm run build` and restart SmartLead. The upgrade saves a database backup in `data/backups/` before making changes. For PostgreSQL, run `npm run db:migrate` and `npm run db:generate` before rebuilding and restarting the application and worker.

You and your friend sign in with different email addresses and connect your own WhatsApp and sheets. On one browser, sign out before changing accounts; separate browser profiles can stay signed in simultaneously. For access from another computer, both users need a reachable hosted installation (see Production installation); `127.0.0.1` only works on the computer running SmartLead.

The server-level Google service account remains available to the original organisation only. Other organisations must connect their own Google credentials for authenticated sheets; public sheet links continue to work without Google authentication.

## Run the local demo

Node.js **22.18 or newer** is required. Dependencies and demo data are already installed in this workspace.

Double-click **Start SmartLead.cmd**. It starts both the built application and automatic sending in the background, waits until they are ready, and opens **http://127.0.0.1:3000/login**. They keep running after the launcher closes. Run the launcher again after restarting Windows; opening it again while the app is running reuses the existing processes. Logs are in `data/smartlead-server.log`, `data/smartlead-server.error.log`, `data/smartlead-worker.log`, and `data/smartlead-worker.error.log`.

1. Log in. The dashboard has only **Connect Sheets** and **Connect WhatsApp** cards.
2. Open **Connect WhatsApp** → **Connect WhatsApp**. SmartLead loads the original `https://web.whatsapp.com/` in a background browser with no visible window. If linking is needed, scan the original website's live QR shown in SmartLead. Its existing saved login is reused when available. After linking, you can close the dashboard and all visible browser windows; the background worker keeps sending.
3. In Google Sheets, set **Share → General access → Anyone with the link → Editor**, then open **Connect Sheets** and paste the link. No Google login, service-account key, or API setup is needed.
4. Choose the tab and check the automatically detected customer-name and phone columns. SmartLead reads the public sheet directly and stores sending progress in its local database.
5. Select recipients from your linked WhatsApp account. If someone is missing, add their phone number. **Save & start sending** starts the queue. A new conversation starts on the first message to a registered WhatsApp number.

Existing rows are sent when you start. Each sheet checks for new rows every minute. Sending runs sequentially in the background; the round-robin cursor and source IDs persist across restarts. You can edit recipients or pause a sheet from its card. It displays real connections rather than the fictional seed sources.

Every new message includes the sheet name, its questions and answers in source order, the lead's name, phone and city, and a private feedback link. Employees open the link without an administrator login, select a lead status, enter feedback and save. The background worker updates the same source lead in **lead_status → shared to → Feedback**. Existing status and feedback are preserved when connecting or upgrading; `shared to` records the assigned employee's name. Missing output columns are added, and whole output columns are moved together when necessary, preserving existing source data. The form confirms when Google has accepted the update; temporary failures remain queued for retry.

The message follows this format:

```text
Hello

You got a new lead from Sheet Name

Here's what we know:

Q.1 - What is your approximate budget?
Ans.- The answer from this row

Name: Customer name
Phone: Customer phone
City: Customer city

Submit Feedback
Private link for this lead

Thank you!
```

Lead 1 goes to selected person 1, lead 2 to person 2, and so on before repeating. Saving the same recipients preserves the next person in that rotation. Changing the list redistributes only unsent leads across the new list; submitted leads are retained. Sheet cards show submitted, queued, and failed counts. On reconnect, SmartLead checks uncertain attempts against existing outgoing messages using the exact recipient, body, and attempt time. A unique match repairs the record without sending another message; unmatched or ambiguous attempts remain held.

Public imports use a mapped Lead ID when present. Otherwise they identify each lead by its normalized phone number plus lead date, when available. Reordering rows or editing a customer's name does not resend that lead. Repeated rows with the same phone and date are imported once; use distinct Lead IDs or dates when separate leads share a phone number. Public-sheet writeback uses an isolated background browser and the original Google Sheets editor; no Google account or key is required. Keep link sharing set to **Editor**. Deleted source leads and edits to already managed output cells stop writeback instead of overwriting another row or an external edit.

## Feedback links: local testing and Hostinger

For testing clickable links in WhatsApp on this PC, leave `APP_URL=http://127.0.0.1:3000` and `PUBLIC_FEEDBACK_URL` empty in `.env`, then open **Enable Local Feedback.cmd** once (or run the command below):

```powershell
npm run feedback:local-clickable
```

Windows requests administrator access to add only `127.0.0.1 smartlead.example.com` to its hosts file, with a backup in `data/backups/`. This reserved example hostname points to this PC only. WhatsApp's link detector recognizes `http://smartlead.example.com:3000/feedback/...`; it ignores raw loopback IP addresses, `localhost`, and reserved `.test` names. The setup enables local feedback and refreshes queued messages while preserving their tokens. Previously delivered messages keep their old addresses. Restart the application and worker after upgrading the code.

Open new feedback links in WhatsApp Web on the PC running SmartLead. This local mapping cannot open the PC's form from a phone or another computer. Keep the application and worker running with **Start SmartLead.cmd**. No hosting, DNS provider or tunnel is needed for this test. For browser-only tests with the raw loopback address, `npm run feedback:local` permits local feedback without adding a hostname.

With QR-based WhatsApp, messages include **Submit Feedback** followed by the complete clickable URL on its own line. WhatsApp Web does not support hiding a URL behind arbitrary text. Anyone holding a lead's signed link can view that lead and submit feedback until the link expires or the assignment changes.

When deploying to Hostinger, point your domain to the hosted server, enable HTTPS, and set `APP_URL=https://your-domain` in the server's `.env`. Restart the web application and worker. Feedback links then use that domain directly, ahead of any previous relay configuration; Cloudflare is not required. Follow Production installation below for the persistent application, database and worker. Keep `PUBLIC_FEEDBACK_URL` empty when the feedback form shares the application's domain.

`npm run feedback:refresh-links` updates queued messages to the configured address without sending anything or changing their private feedback tokens. Previously delivered WhatsApp messages keep their original links. Unsent messages also refresh their links before sending. Without the explicit local test setting, new sends require a public HTTPS feedback address.

For source development, use `npm run dev` and keep that terminal open. Rebuild with `npm run build` before starting an updated production build with the launcher.

Run `npm run worker` in a second terminal when developing; the Windows launcher starts it automatically. The WhatsApp browser saves its login in a dedicated profile under `data/whatsapp-web/`, separate from your everyday browsing profile. Background mode is the default (`WHATSAPP_LOGIN_MODE=background`); it creates no desktop window. Restarting the worker reconnects to that browser and profile instead of creating another linked device. The sending SDK attaches only after you sign in on the original site. The phone must approve device linking; SmartLead cannot override a WhatsApp account restriction.

Local sending still needs the computer, internet, and background worker running. Closing browser windows is supported; shutting down the computer stops local sending. A later Hostinger VPS deployment can run the same worker and background browser without your local computer, using the persistent `sender-archives` volume for its profile. Link the account once on the server; Windows browser profiles are not copied to Linux. Set `WHATSAPP_LOGIN_MODE=native` only if you explicitly want the earlier visible desktop login mode.

| Role | Email | Demo password |
| --- | --- | --- |
| Super Admin | admin@smartlead.demo | SmartLead!2026 |
| Sales Executive | akash@smartlead.demo | SmartLead!2026 |
| Sales Executive | aman@smartlead.demo | SmartLead!2026 |
| Sales Executive | kunal@smartlead.demo | SmartLead!2026 |
| Sales Executive | sahil@smartlead.demo | SmartLead!2026 |

For a fresh checkout:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm ci
npm run demo:setup
npm run dev
```

`demo:setup` creates random local secrets, an SQLite database, a local administrator and legacy fictional fixtures. Re-running it preserves existing records. The simplified interface hides those fixtures and uses real Google Sheets and WhatsApp Web connections. `DEMO_MODE=true` selects local SQLite; it does not simulate the connections created by the simplified interface. A publicly shared sheet link and a linked WhatsApp account are required for live use.


## Production installation

Production requires a Linux/Docker host with persistent Node processes. The WhatsApp browser session and Redis/PostgreSQL connections cannot run on a static host or a Cloudflare Worker. No external site was published.

1. Copy `.env.example` to `.env`. Set `DEMO_MODE=false`, the public HTTPS `APP_URL`, a strong `POSTGRES_PASSWORD`, `ADMIN_EMAIL`, and a unique `ADMIN_PASSWORD` of at least 12 characters. Do not use demo passwords.
2. Generate `SESSION_SECRET` with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` and `ENCRYPTION_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep the encryption key stable and backed up separately from the database.
3. Configure Google, WhatsApp, and SMTP as described below.
4. Run:

```sh
docker compose up -d --build
docker compose run --rm web npm run seed
```

The one-time migration service applies the committed PostgreSQL migration before the web and worker services start. `seed` creates only a production administrator when `DEMO_MODE=false`. It does not insert fictional records in production.

Put an HTTPS reverse proxy in front of `127.0.0.1:3000`; `deploy/Caddyfile` is supplied. Set `SMARTLEAD_DOMAIN` to your domain when using Caddy. Configure the public `APP_URL` before issuing feedback links. Do not expose PostgreSQL or Redis publicly. Use a single dedicated worker instance; it serializes browser sends and owns all Web sessions. Scale web instances independently.

Without Docker, provision PostgreSQL and Redis, set their URLs, then run `npm ci`, `npm run db:migrate`, `npm run seed`, `npm run build`, `npm start`, and `npm run worker` under a process supervisor. Install Chromium and set `CHROME_PATH` for Web senders.

## Google Sheets

Enable the Google Sheets API in your Google Cloud project.

**OAuth:** set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`. Register the exact callback `https://your-domain/api/integrations/google/callback` in Google Cloud. Open Settings → Integrations → Connect Google account. Refresh tokens are encrypted in the database. The requested `spreadsheets` scope supports arbitrary pasted sheet URLs without Drive listing; only sheets the account can access are available.

**Service account:** base64-encode the service account JSON into `GOOGLE_SERVICE_ACCOUNT_BASE64`. Share each spreadsheet with the service account's `client_email` as **Editor**. Keep the environment secret server-side.

Add a Google Sheet, select a tab, map its source fields, and either map a unique existing Lead ID or explicitly approve adding a SmartLead ID column. Source identity is immutable after connection. Configure a separate connection for another tab. Map output fields to distinct application-managed columns. Automatic column creation requires explicit approval in the connection form.

Imports scan the source and compare fingerprints; unchanged customer data is not rewritten. Stable source IDs and database uniqueness prevent repeated imports. Row metadata anchors output writes to row identity, so a reorder does not turn a saved row number into authorization to write elsewhere. Missing/changed IDs and deleted/ambiguous rows stop writeback. Only mapped managed fields are written; null entries skip unrelated cells and RAW writes avoid formula interpretation.

Externally edited managed cells trigger a conflict instead of being silently overwritten. Compare the source with database feedback history, resolve the managed cell deliberately, then retry writeback from the lead detail screen. During initial metadata attachment, avoid sorting/editing the sheet; detected changes stop synchronization and show a troubleshooting message. Metadata adds no replacement customer information. Large initial imports can take multiple quota-limited retries. Schedule intervals must be at least 60 seconds.

Google Sheets does not provide a compare-and-swap transaction with the application database. Metadata and identity checks prevent row-address mistakes, but editors should avoid modifying application-managed columns while a write is in progress. Database feedback history remains the authoritative audit record.

## WhatsApp

Add internal recipients in Sales Team, then configure each sheet's recipients, accountable-owner strategy, and sender in Lead Distribution. Only selected, active employees can receive customer information. Daily limits and pending-workload capacity are enforced. “Notify everyone” creates one primary owner and multiple notification records; notification-only recipients do not get an editable feedback link.

**Background browser login (default on Windows and Linux):** use **Connect WhatsApp** and scan the original site's QR if requested. The dedicated browser runs without a visible window and persists its profile in `data/whatsapp-web/`. Browser control binds to loopback only. `WHATSAPP_LOGIN_MODE=native` opts into a visible desktop window with **Open WhatsApp Web**.

**Legacy RemoteAuth provider:** `WHATSAPP_LOGIN_MODE=headless` selects the earlier SDK-managed QR login explicitly. RemoteAuth archives are encrypted. Wait at least one minute after initial authentication for the first archive backup before restarting. Both browser modes use the WhatsApp Web adapter after authentication; a submission record does not guarantee delivery or reading.

**Official Meta provider:** add a phone number ID and system-user access token in WhatsApp Connections. Set the API version in `META_GRAPH_VERSION`; configure `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN`. Register `https://your-domain/api/webhooks/whatsapp` as the callback and subscribe the WABA to message status events.

Each sheet using Meta must name an approved template and approved language. Its body must accept these five text parameters in order: **customer name, customer mobile, project, assigned employee, feedback URL**. Notifications always use a template, including outside any customer-service window. Confirm the template and internal-recipient authorization in your own Meta account. Signed webhooks update sent/delivered/read states monotonically. Secrets are encrypted and omitted from API responses.

Submission timeouts and worker crashes during a possible send are flagged **uncertain** and held for human reconciliation. Confirmed failures have an explicit Retry action. Disconnected-account jobs remain queued and resume after reconnection. The system cannot promise exactly-once delivery when an external provider has accepted a message without returning a reliable response.

## Security and operations

- Salted scrypt password hashing; signed, revocable server sessions in HttpOnly cookies; optional TOTP; SMTP password resets; role checks on every protected API.
- Super administrators manage integrations and users. Managers access assigned sheets and their configured employees. Executives access only active primary assignments. New managers can be created in Settings → Roles & access; create executive logins when adding a team member.
- Feedback links contain a signed random token, store only its hash, expire, and are revoked on reassignment. A link grants access to one assignment; treat it as a password. Feedback submissions use optimistic versions to prevent concurrent overwrites. Never place feedback URLs in analytics or access logs; reverse proxies should suppress/redact `/feedback/` and `/api/feedback/` paths.
- Durable database outbox, atomic claims, exponential backoff, eight-attempt dead-letter handling, BullMQ rate limiting, stale-lock recovery, and privacy-safe application logs. Settings → Automation health exposes pending/dead-letter work.
- Back up PostgreSQL, encryption keys, and encrypted sender archives; test restores. Health: `GET /api/health`. Observe worker errors and dead-letter counts. Configure SMTP for real reset email delivery; unconfigured resets return a generic response without pretending to send mail.
- Data retention is deliberate: set `RETENTION_DAYS` (minimum 30), run `npm run retention` to preview, then `npm run retention -- --apply` to redact eligible closed application records. This removes customer/contact text from leads, feedback and message bodies, revokes access, and retains pseudonymous source-identity tombstones to prevent re-import. It does not modify the original spreadsheet; handle its retention separately.
- Use this system only for an authorized sales workflow and authorized internal recipients. There is no customer broadcast, contact scraping, or automatic customer-facing marketing flow.

## Verification

```sh
npm run typecheck
npm test
npm run build
# With npm run dev running; Windows uses installed Edge by default:
npm run test:e2e
```

The integration suite creates its own SQLite database and mocks external providers. Browser tests use the fictional demo workspace and submit explicitly labeled fictional feedback. Browser screenshots are generated in `data/`. For Linux browser QA, change Playwright's `channel` or install the appropriate supported browser. The PostgreSQL/Redis Docker runtime and live Google/Meta/phone authentication must also be tested in your deployment environment; those external services are not available in this workspace.

API details: [docs/API.md](docs/API.md). The schema, migrations, worker and providers are in `prisma/`, `src/worker.ts`, and `src/lib/`. The UI is in `src/components/`.
