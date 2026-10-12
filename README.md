# SmartLead

A simple Google Sheets → WhatsApp lead sender. Log in, connect multiple sheets, link one WhatsApp Web account, and choose recipients for each sheet. Leads go to one selected person at a time in order, then repeat.

## Separate organisations

Use **Create an account** on the login page (or `/register`) for each organisation. Enter your name, organisation name, email, and a password of at least 12 characters. Your email is your login ID. Each registration opens an empty workspace with its own WhatsApp connection, Google Sheets, contacts, recipients, leads, credentials, settings, and job history. Administrators can access only their own organisation. Users added through the team API belong to the inviting administrator's organisation; use registration for an independent organisation.

SmartLead now uses MongoDB by default. This installation starts with an empty `smartlead` database; previous SQLite files remain untouched and are not imported. Create new organisation accounts and connect their sheets and WhatsApp separately. The old SQLite organisation upgrade is available only for explicitly configured legacy demo installations.

You and your friend sign in with different email addresses and connect your own WhatsApp and sheets. On one browser, sign out before changing accounts; separate browser profiles can stay signed in simultaneously. For access from another computer, both users need a reachable hosted installation (see Production installation); `127.0.0.1` only works on the computer running SmartLead.

The server-level Google service account remains available to the original organisation only. Other organisations must connect their own Google credentials for authenticated sheets; public sheet links continue to work without Google authentication.

## Run locally with MongoDB

Node.js **22.18 or newer** is required. Configure MongoDB using the steps below before the first start. Use Create an account to register your organisation; the empty database has no pre-created demo login.

Double-click **Start SmartLead.cmd**. It starts both the built application and automatic sending in the background, waits until they are ready, and opens **http://127.0.0.1:3000/login**. They keep running after the launcher closes. Run the launcher again after restarting Windows; opening it again while the app is running reuses the existing processes. Logs are in `data/smartlead-server.log`, `data/smartlead-server.error.log`, `data/smartlead-worker.log`, and `data/smartlead-worker.error.log`.

1. Log in. The dashboard has only **Connect Sheets** and **Connect WhatsApp** cards.
2. Open **Connect WhatsApp** → **Connect WhatsApp**. SmartLead loads the original `https://web.whatsapp.com/` in a background browser with no visible window. If linking is needed, scan the original website's live QR shown in SmartLead. Its existing saved login is reused when available. After linking, you can close the dashboard and all visible browser windows; the background worker keeps sending.
3. In Google Sheets, set **Share → General access → Anyone with the link → Editor**, then open **Connect Sheets** and paste the link. No Google login, service-account key, or API setup is needed.
4. Choose the tab and check the automatically detected customer-name and phone columns. SmartLead reads the public sheet directly and stores sending progress in its MongoDB database.
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

Local sending still needs the computer, internet, and background worker running. Closing browser windows is supported; shutting down the computer stops local sending. A later Hostinger VPS deployment can run the same worker and background browser without your local computer, using the persistent `browser-runtime` volume for its profile. Link the account once on the server; Windows browser profiles are not copied to Linux. Set `WHATSAPP_LOGIN_MODE=native` only if you explicitly want the earlier visible desktop login mode.

## Database setup

MongoDB uses databases and collections rather than folders. SmartLead creates its own **smartlead** database on your existing server, containing collections such as `organizations`, `users`, `sheets`, `senders`, `leads`, `feedback`, `jobs`, and `settings`. Other databases are not accessed or changed. A URI that names another database is still redirected to `MONGODB_DATABASE=smartlead`; its authentication database is preserved. Alternative project database names must start with `smartlead_`.

1. Copy `.env.example` to `.env`. Set `MONGODB_URI` to your existing connection string, `MONGODB_DATABASE=smartlead`, `DATABASE_PROVIDER=mongodb`, and `DEMO_MODE=false`. Keep `.env` private and ignored by Git.
2. Set random secrets. Generate `SESSION_SECRET` with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` and `ENCRYPTION_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Preserve your existing secrets when upgrading.
3. Allow the application server's IP in Atlas Network Access and give the database user read/write access to `smartlead`. MongoDB must support transactions through a replica set; Atlas supplies this.
4. Run:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm ci
npm run db:setup
npm run build
```

Then open **Start SmartLead.cmd**, choose **Create an account**, and connect your organisation's WhatsApp and sheets. Setup creates collections, indexes, and a project marker; it does not seed users or import old data. Re-running setup preserves SmartLead records and restores required indexes. It refuses an occupied database without the SmartLead project marker. Do not use `prisma db push` or `prisma migrate` for MongoDB: `db:setup` maintains partial unique indexes that allow multiple unlinked employees and messages without provider IDs.

All application records, login sessions, Google/Meta credentials, contacts, feedback, audit history, and durable automation jobs use MongoDB. Credentials and SDK RemoteAuth backups are encrypted with `ENCRYPTION_KEY`; backups use the `whatsapp_archives.files` and `whatsapp_archives.chunks` GridFS collections. Background/native Chromium profiles, temporary SDK files, build output, and runtime logs still need worker filesystem storage. Keep the browser profile volume and encryption key when restoring or moving the server.

For the optional fictional SQLite demo in a separate checkout, set `DATABASE_PROVIDER=sqlite` and `DEMO_MODE=true`, then run `npm run demo:setup`. This legacy mode uses `DEMO_DATABASE_URL` and demo-only credentials `admin@smartlead.demo` / `SmartLead!2026`. `DEMO_MODE` controls demo providers and fixtures; it does not select the database. Do not run demo setup on the MongoDB installation.

## Production installation

Use a Hostinger VPS or another host supporting persistent Node processes and Chromium. Static website hosting cannot run the worker. Point your domain to the server, enable HTTPS, and set `APP_URL=https://your-domain` in `.env`; feedback then uses your domain directly. Cloudflare is not required. Keep `PUBLIC_FEEDBACK_URL` empty when feedback shares the app's domain.

Configure the same MongoDB settings and secrets above, allow the hosting server's IP in Atlas, then run:

```sh
docker compose up -d --build
```

The setup service initializes only SmartLead's database before the application and worker start. No PostgreSQL or Redis service is required. Register accounts at `/register`; `npm run seed` is optional and requires explicit `ADMIN_EMAIL` and `ADMIN_PASSWORD` values when `DEMO_MODE=false`.

Put an HTTPS reverse proxy in front of `127.0.0.1:3000`; `deploy/Caddyfile` is supplied. Set `SMARTLEAD_DOMAIN` when using Caddy. Use one dedicated worker; it owns browser sessions, polls the MongoDB outbox, atomically claims jobs, and serializes sends with a delay. Web instances may run independently. The browser runtime volume is separate from durable MongoDB records.

Without Docker, configure `.env`, run `npm ci`, `npm run db:setup`, and `npm run build`, then supervise `npm start` and `npm run worker`. Install Chromium and set `CHROME_PATH` on Linux. Back up the `smartlead` database, encryption key, and worker browser profiles.

### Hostinger registration says Invalid request origin

In the website's Hostinger dashboard, open **Environment variables**, set `APP_URL` to that website's exact public HTTPS address (for example `https://your-site.hostingersite.com`, without `/register`), and click **Apply changes**. Restart or redeploy that same website and wait for the deployment to finish. Changing the local PC's `.env` does not change Hostinger's runtime environment. `APP_URL` also controls secure login cookies and feedback links, so keep it configured even behind a reverse proxy. Never remove origin validation or trust arbitrary forwarded-host headers to bypass a mismatched setting.

Also configure `DATABASE_PROVIDER=mongodb`, `MONGODB_URI`, `MONGODB_DATABASE=smartlead`, `DEMO_MODE=false`, `SESSION_SECRET`, and `ENCRYPTION_KEY` in Hostinger. Keep secret values private; the repository deliberately excludes `.env`. Allow the hosting server's IP in Atlas and run `npm run db:setup` on the host before the first registration.

Enter only the connection-string value in Hostinger's `MONGODB_URI` field, without a `MONGODB_URI=` prefix or surrounding quotes. Some hosting environment loaders pass dotenv quotes literally, which can prevent the application from loading. SmartLead accepts one matching pair of surrounding quotes and trims surrounding whitespace; malformed values still fail safely.

Run `npm run config:check` on the hosting server, or inspect the `smartlead_configuration` entry printed by `npm start`. It lists missing/invalid variable names and the application origin without printing database credentials or keys. Then check `/api/health`: it should return `status: ok` and `database: mongodb`. A database health error must be fixed separately from an origin mismatch. See [Hostinger environment-variable instructions](https://www.hostinger.com/support/how-to-edit-or-add-environment-variables-after-deployment/) and [redeployment instructions](https://www.hostinger.com/support/how-to-redeploy-a-node-js-application/).

If compilation succeeds but registration fails, open the website's **Runtime logs**, rather than deployment/build logs. Refresh `/api/health` to generate a `database_health_error` entry. The health response and runtime log identify common failures with a safe `diagnostic.reason`, including authentication, database permissions, network/DNS/TLS, and a missing or incompatible Prisma engine. Missing-engine diagnostics include the required `engineTarget`; generate that target and include the engine in the runtime package. Prisma initialization errors use `errorCode`, which the diagnostic preserves as `prismaCode`. Raw error messages, database credentials, and filesystem paths are never returned. See [Hostinger runtime-log instructions](https://www.hostinger.com/support/how-to-use-node-js-runtime-logs-at-hostinger/).

If runtime logs report `Error parsing resolv.conf: option ... is not recognized`, Prisma's SRV DNS resolver cannot read the hosting server's resolver configuration. Set Hostinger's `MONGODB_URI` to the cluster's **standard `mongodb://` connection string**, including all replica-set members and the correct `replicaSet`, `authSource`, and `tls=true` options. Keep `MONGODB_DATABASE=smartlead`, apply the environment changes, restart the app, and confirm `/api/health` returns `status: ok`. Obtain the standard connection details from Atlas; changing only the URI prefix is insufficient. Keep credentials private and preserve TLS verification. This workaround leaves the hosting server's shared DNS configuration unchanged. Standard connection strings require updating the seed list if Atlas changes the cluster members; see [MongoDB connection-string formats](https://www.mongodb.com/docs/manual/reference/connection-string/).

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
- Durable database outbox, atomic claims, exponential backoff, eight-attempt dead-letter handling, sequential worker send pacing, stale-lock recovery, and privacy-safe application logs. Settings → Automation health exposes pending/dead-letter work.
- Back up the SmartLead MongoDB database, encryption keys, and browser profiles; test restores. Health: `GET /api/health`. Observe worker errors and dead-letter counts. Configure SMTP for real reset email delivery; unconfigured resets return a generic response without pretending to send mail.
- Data retention is deliberate: set `RETENTION_DAYS` (minimum 30), run `npm run retention` to preview, then `npm run retention -- --apply` to redact eligible closed application records. This removes customer/contact text from leads, feedback and message bodies, revokes access, and retains pseudonymous source-identity tombstones to prevent re-import. It does not modify the original spreadsheet; handle its retention separately.
- Use this system only for an authorized sales workflow and authorized internal recipients. There is no customer broadcast, contact scraping, or automatic customer-facing marketing flow.

## Verification

```sh
npm run typecheck
npm test
npm run test:mongodb
npm run build
# With npm run dev running; Windows uses installed Edge by default:
npm run test:e2e
```

The regular suite uses an isolated SQLite fixture for legacy compatibility. `npm run test:mongodb` runs the workflow, organisation-isolation, transaction, uniqueness, and encrypted-archive tests against an isolated local MongoDB replica set; it never uses your Atlas database. Its first run downloads a MongoDB test binary into ignored `data/mongodb-test-binaries/`. Browser tests use the separate fictional demo workspace. Live Google/Meta/phone authentication and Docker deployment still require checks in the target environment.

API details: [docs/API.md](docs/API.md). The schema, migrations, worker and providers are in `prisma/`, `src/worker.ts`, and `src/lib/`. The UI is in `src/components/`.
