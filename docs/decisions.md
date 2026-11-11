# Architecture decisions

Short records of decisions that shape the codebase. Newest last.

## 1. Serverless only, scale to zero

Every component must cost nothing when idle. No API Gateway, VPC, NAT, OpenSearch, RDS, Secrets Manager or WAF at MVP. CloudFront fronts both the SPA (S3) and the API (Lambda Web Function).

## 2. TypeScript on Node.js 24 / arm64

Lambda Web Functions launched (2026-10-12) with Node.js 24 on arm64 only. All packages use TypeScript so types are shared through `@sesame/core`.

## 3. Terraform, with `awscc` for Web Functions

Checked 2026-10-27:

- `hashicorp/aws` v6.70.0 has **no** Web Function support. `aws_lambda_function` has no web/HTTP-server configuration.
- `hashicorp/awscc` exposes the CloudFormation types:
  - `awscc_lambda_web_function`: the function container (name, tags).
  - `awscc_lambda_web_function_revision`: immutable code and config. Code comes from an S3 object, plus a runtime, execution role, env vars, timeout and `max_concurrency_per_environment`.
  - `awscc_lambda_web_function_endpoint`: the HTTPS endpoint. It has `auth_type`, `endpoint_type`, `regions`, `revision_weights` (1–2 entries, which allows blue/green), `scaling_config.max_environments` and `throttle_config.rate_limit`.

Decision: everything uses `hashicorp/aws` except the `web` module, which uses `awscc` for those three resources and for `awscc_lambda_resource_policy` (CloudFormation's `AWS::Lambda::ResourcePolicy` accepts Web Function ARNs).

Confirmed in M2:
- `auth_type` is `ApplicationManaged` or `IamAuth`; `endpoint_type` is `HomeRegion`, `MultiRegion` or `PerRegion`.
- CloudFront OAC signs requests to a Web Function: origin type `lambda`, signing behavior `always-amz-auth` (the only one these origins support). The endpoint uses `IamAuth`, and the function's resource policy lets `cloudfront.amazonaws.com` call `lambda:InvokeWebFunctionEndpoint` on it, conditioned on the distribution ARN. No shared-secret header is needed.
- The `/api/*` behavior must use an origin request policy that drops the viewer's `Host` header (`AllViewerExceptHostHeader`), or the endpoint returns 404.
- The server must listen on `AWS_LAMBDA_HTTP_ENDPOINT` (`host:port`). The runtime loads `index.js` unless `AWS_LAMBDA_NODEJS_ENTRYPOINT` names another file; sesame uses `server.mjs`.
- The AWS SDK isn't documented as part of the Web Function runtime, so the API bundles its own.

## 4. DynamoDB GSIs use `key_schema` blocks

In `hashicorp/aws` v6.70, the `hash_key` and `range_key` arguments inside `global_secondary_index` are deprecated in favour of `key_schema` blocks. The table-level `hash_key` and `range_key` are not deprecated.

## 5. Two tables

- `sesame-directory` holds domains, addresses, mailboxes, members, suppression entries and rate counters.
- `sesame-mail` holds messages, folder counters, Message-ID → thread maps and search tokens.

Key formats live only in `packages/core/src/keys.ts`.

## 6. Deterministic message IDs

Message sort keys are ULIDs. At ingest, the random part is derived from `sha256(sesMessageId:mailboxId)`, so an SQS redelivery produces the same key and a conditional put dedupes it.

## 7. Ingest consumes SES notifications, not S3 events

The MIME that SES stores in S3 has no envelope, so a recipient who was only Bcc'd can't be recovered from it. The receipt rule's S3 action therefore sets `topic_arn`. After storing the object, SES publishes a `Received` notification that carries:

- `receipt.recipients`, the envelope recipients the rule matched;
- the spam, virus, SPF, DKIM and DMARC verdicts;
- the object's bucket and key.

The pipeline is SNS, then SQS with raw message delivery, then the ingest Lambda. Internal delivery (M4) puts a `DeliveryJob` with `source: "internal"` on the same queue.

Setup notifications and other non-`Received` messages are acknowledged and ignored. Malformed jobs fail, are retried, and land in the DLQ.

## 8. Unknown recipients are dropped, never bounced

The receipt rule accepts every address at the domain. Ingest delivers to addresses, aliases and the domain catch-all, and logs and drops everything else. Bouncing after acceptance would send backscatter to forged senders.

Messages with a virus verdict of `FAIL` are dropped. Their landing copy stays under `raw/` until the lifecycle rule expires it. Messages with a spam verdict of `FAIL` are delivered to `junk`.

## 9. Mailbox membership is keyed by login email

Members are stored as `MEMBER#{email}` with GSI1 `USER#{email}`. The email is the normalized email claim of the signed-in user. Admins can therefore grant access before a user's first login, without knowing their Cognito `sub`.

This means the API must only trust a verified email claim from Cognito. The federation mapping set up in M2 must guarantee that.

## 10. HTML is sanitized at ingest, isolated at render

`sanitize-html` removes scripts, event handlers and `javascript:` URLs, and forces links to open with `noopener`. `<style>` and inline styles are kept, because most HTML mail needs them.

This is defense in depth, not the boundary. The SPA must render bodies in a sandboxed iframe without `allow-scripts`, under a CSP that blocks remote loads by default.

## 11. BFF session in an encrypted cookie

The API, not the browser, talks to Cognito. `/api/auth/login` starts an authorization code flow with PKCE, state and nonce, and keeps them in a short-lived sealed cookie. `/api/auth/callback` exchanges the code, verifies the ID token with `aws-jwt-verify`, and sets `__Host-sesame_session`: an AES-256-GCM sealed `{sub, email, name}` with a 12-hour absolute lifetime. The cookie is `HttpOnly`, `Secure` and `SameSite=Lax`.

- No tokens are stored and the app client has no secret. When a session expires, the user goes back through Cognito, which usually signs them in again without a prompt.
- State-changing requests also need an `X-Requested-With` header and must not come from another site (`Sec-Fetch-Site`). UI and API share one origin, so the API sends no CORS headers.
- An email is trusted for membership when the user is federated (the ID token has `identities`, so the email comes from an admin-configured IdP) or `email_verified` is true. Every IdP must map `email`.

## 12. Runtime config in SSM, not in the revision

The CloudFront domain and Cognito client ID depend on the endpoint, which depends on the revision. To avoid a dependency cycle, the revision's environment holds only table and bucket names plus the name of a SecureString parameter. That parameter holds the public URL, the Cognito settings and the cookie key, and the API reads it once per execution environment.

The trade-off: changing it doesn't create a new revision, so running environments keep the old values until they're recycled.

## 13. How the SPA renders message bodies

HTML bodies go in an `<iframe srcdoc>` with `sandbox="allow-popups allow-popups-to-escape-sandbox"`. Without `allow-scripts` or `allow-same-origin`, the frame runs no code and has an opaque origin. Links open in a new tab outside the sandbox.

The frame document carries its own CSP: `default-src 'none'`, inline styles allowed, and images only from `data:` and the presigned URLs of the message's own inline parts. Remote images stay blocked until the user clicks "Show images". A srcdoc frame also inherits the SPA's CSP, which therefore allows `'unsafe-inline'` styles and `https:` images.

Inline `cid:` images can't use the attachment redirect. The opaque-origin frame doesn't send the `SameSite=Lax` session cookie, and `fetch()` can't follow a cross-origin redirect. So the SPA asks for the presigned URL with `?as=url`, and rewrites `cid:` references to it before building the frame.

The parent can't measure the height of the cross-origin frame, so the frame fills the reader pane and scrolls on its own.

## 14. Outgoing mail is built once and routed by recipient

The API builds the MIME with nodemailer's MailComposer and stores it once at `raw/outbound/{id}.eml`. Bcc is never written into the headers; Bcc recipients exist only in the routing below.

- **Local recipients:** addresses in the directory (including aliases) go to the ingest queue as an internal `DeliveryJob`, the same path inbound mail takes. They never touch SES.
- **The Sent copy:** the same job carries `sentCopy`, so ingest files the message in the sender's Sent folder (read, with a delivery state) using its own deterministic ID. Sending to yourself produces two messages: one in Inbox, one in Sent.
- **External recipients:** a `SendJob` goes to the send queue. The sender Lambda calls SES v2 `SendEmail` with the raw message and those addresses as the envelope.

The API refuses:
- an address at an accepted domain with no mailbox, since SES would only loop it back to be dropped;
- an external address on the suppression list;
- a From address that isn't the mailbox's own primary address or alias.

## 15. SES sends happen at most once

SQS delivers at least once, so the sender claims a `SEND#{jobId}` lock item before calling SES, and records the SES message ID on it afterwards.

- **Redelivery after a send:** a lock with an ID only redoes the bookkeeping: the `SES#{messageId}` → Sent copy map, and marking recipients `sent`.
- **Interrupted attempt:** a lock without an ID means the earlier attempt stopped at an unknown point. The recipients are marked `failed`, with a note to resend, rather than risking a duplicate.
- **Throttling:** SES throttling and 5xx errors release the lock and retry.

SES events (send, delivery, bounce, complaint, delay, reject) reach the ses-events Lambda through the configuration set, SNS and SQS. They update recipients in the Sent copy through an optimistic check on `delivery.updatedAt`. A final state such as delivered or bounced is never overwritten by a late `sent` or `delayed` event.

Permanent bounces and complaints add a `SUPPRESS#` item that the API checks before sending. SES's account-level suppression list also applies.

## 16. Search is a token index in the mail table

There's no OpenSearch: its idle cost would dwarf everything else. Ingest tokenizes each message and writes one item per (token, message). Tokens are folded to lowercase without accents, with stopwords dropped. Up to 200 tokens are kept per message, taken in priority order: subject, sender, recipients, attachment names, then the first 8 KB of the body.

- **Keys:** pk `MBX#{mbx}#S#{first two characters}`, sk `{token}#{ulid}`. The `f` string set records which fields the token came from.
- **Matching a word:** one query on its shard with `begins_with(sk, word)`, which gives prefix matching. Field operators add a `contains(f, …)` filter.
- **Combining words:** results are intersected on the message ID and sorted newest first. Then messages are loaded 100 at a time and filtered on folder, attachments, unread and flagged until a page is full. Junk and Trash are excluded by default.
- **Limits:** each word reads at most 2,000 index entries. A word that matches more than that sets `truncated`, and the SPA suggests adding words.
- **Deleting:** the message item keeps its token list, so purging from Trash deletes the index items too. `sesame search reindex` rebuilds the index from `body.json`.

Cost: roughly one write per token, so about $0.0002 per message on demand with bodies indexed. Indexing only headers and attachment names cuts that to about a quarter.

## 17. Full mailboxes hold mail in the DLQ instead of bouncing it

A mailbox at or over `quotaBytes` takes no new mail. DynamoDB conditions can't add, so delivery checks `usedBytes < quotaBytes` in the delivery transaction. The message that fills a mailbox is accepted, so usage can overshoot by one message.

- **Local senders:** the API refuses with an error naming the full mailbox, so they know right away.
- **Mail from outside:** bouncing it would be backscatter (decision 8), and SES can't refuse it per mailbox during the SMTP session.
  - Ingest fails the job instead, and SQS retries it and then parks it in the ingest DLQ. Other recipients of the same message are delivered normally; retries see them as duplicates.
  - The dead-letter alarm tells an administrator, who frees space and redrives. The DLQ and the `raw/` landing copies both last 14 days, so held mail survives that long.
- **Sent copies:** never refused. The API already blocks sending from a full mailbox, and a sent message's record should not be lost to a race.

## 18. Alarms stay within the CloudWatch free tier

The `observability` module has nine alarms:

- dead letters on each of the four pipelines (ingest, send, events and, since decision 21, purge);
- message age on the ingest and send queues;
- API 5xx responses;
- SES bounce and complaint rates.

That fits the free tier of 10 alarm metrics per account, so monitoring adds nothing to idle cost.

Signals a dead-letter alarm already covers, such as Lambda errors on SQS consumers, get no alarm of their own. Their retries are expected, and only exhausted retries need a person. Mail content never appears in alarm notifications, so the topic needs no customer-managed KMS key.

Dead-letter queues are redriven with SQS's native message move task, through `sesame queue redrive` or the console. Every consumer is idempotent (decisions 6 and 15), so a redrive is always safe to repeat.

## 19. One custom domain for the app and the API

`web_domain` names the CloudFront distribution, which serves both the SPA and `/api/*`. The app and API therefore stay same-origin: there is still no CORS, the `__Host-` session cookie works unchanged, and no second certificate is needed.

- **Certificate:** CloudFront requires one from us-east-1. The `web` module therefore takes an `aws.us_east_1` provider alias, even when the deployment runs in another region.
- **DNS:** with a Route 53 zone, Terraform issues and validates the certificate and creates `A`/`AAAA` aliases. Without one, the operator supplies `certificate_arn` and publishes a `CNAME`.
- **The `*.cloudfront.net` name:** the SPA's CloudFront function redirects it to the custom domain. That keeps users on the origin whose cookie and Cognito callback are configured.
- **API config:** the API reads `publicUrl` from SSM once per execution environment. The domain is therefore also passed as an environment variable, so changing it creates a new revision and every environment reloads the config.

## 20. The admin console is server-rendered, on its own Web Function

The console is low-traffic and made of forms and tables. Rendering HTML on the server (Hono JSX, post/redirect/get) avoids a second JSON API and a client bundle, and lets the CSP forbid scripts entirely.

- **A separate function.** It isn't more routes in the API, because a separate function gets its own IAM role and limits. That role can change the directory and redrive queues, but can't read the mail bucket or mail table; the API's role can't redrive queues or read SES account status.
- **Shared code.** The CLI and the console share one implementation of directory and queue operations, in `@sesame/ops`.
- **Sign-in.** The console sits on the distribution's origin at `/admin*` and reuses the API's sign-in and `__Host-` session cookie. The API now copies the ID token's `cognito:groups` claim into the session at sign-in. The console admits members of `<name>-admins`, so a group change takes effect at the next sign-in (12 hours at most).
- **CSRF protection.** Plain HTML forms can't send the custom header the API requires, so the console checks the `Origin` header against the public URL, using Hono's `csrf` middleware, on top of `SameSite=Lax`.
- **Activity log.** Every change is written to an `AUDIT` partition in the directory table, kept for 180 days.

Confirmed while building it: an endpoint's `throttle_config.rate_limit` only accepts 0, 100, 200 … 1,000, 2,000 … 10,000.

## 21. Deleting a mailbox: directory first, then an asynchronous purge

Deleting a mailbox happens in two steps, so that it's immediate for users and complete for storage.

1. **Directory.** One transaction removes the mailbox item, its addresses (each only if it still points at this mailbox), its members and any catch-all that names it, and writes a `PURGE#<id>` marker. From then on no mail can reach it and nobody can open it.
2. **Purge.** A job on the `<name>-purge` queue lets a classic SQS-driven Lambda delete the mail. That covers every item in the `MBX#<id>` partition, each message's search tokens (found through the message's `tokens` attribute) and every object under `mbx/<id>/`. A final pass 15 minutes later catches deliveries that were already in flight, then removes the marker.

Why not delete everything from the admin console:

- **Timeouts.** A large mailbox can't be deleted within one web request. The purge Lambda hands over to a fresh invocation when its time runs low.
- **Separation of duties.** The admin console can't read or delete mail. The purge role can delete mail, but it has no `s3:GetObject`, so it can't read message content either.
- **Safety.** The purge refuses to run for a mailbox that exists in the directory, so a stray job can't empty a live mailbox.

Mail that a deleted mailbox had already queued still goes out. The sender and `ses-events` check whether the mailbox exists when its Sent copy is missing: if it was deleted, they drop the update instead of retrying it into a dead-letter queue.

## 22. ActiveSync on its own Web Function, with app passwords

iPhone Mail syncs with Exchange servers over Exchange ActiveSync (EAS). sesame serves EAS 14.1, which current iOS speaks, for mail only. IMAP would also work for reading, but sending would then need SMTP submission, which means a long-running server.

- **Its own function, behind the same distribution.** The plan was a public endpoint with `ApplicationManaged` auth, called directly, so that a held `Ping` could outlast CloudFront's origin timeout. On first deploy Lambda refused the resource policy, because it would make the function public. The `eas` endpoint therefore uses `IamAuth`, and the app's distribution routes `/Microsoft-Server-ActiveSync*` and `/autodiscover/*` to it with origin access control. Phones use the app's own host name as the server, with its certificate. The function has its own role (the mail table, the directory items it needs, `mbx/*`, `raw/outbound/*` and the two outbound queues) and its own scaling and rate limits.
- **Getting the phone's request through.** `always-amz-auth` signing leaves the viewer's `Authorization` header alone, but CloudFront forwards it only when it's in the cache key. The eas behaviors therefore use their own cache policy keyed on `Authorization` and the query string; nothing is cached, because the function answers with `no-store`. Their origin request policy forwards the ActiveSync headers and `CloudFront-Viewer-Address`, which per-IP throttling uses instead of the client-controlled start of `X-Forwarded-For`. CloudFront path patterns are case-sensitive, so both spellings of each path are routed.
- **App passwords, not Cognito.** iOS supports OAuth for EAS only against Microsoft's identity platform, so phones send HTTP Basic credentials on every request. Users create app passwords on the **Phones and devices** page. Each one opens one mailbox, is 24 random base32 characters (about 120 bits) and is stored as a SHA-256 hash under `APPPW#<hash>`. That entropy makes a slow hash unnecessary, so a sign-in is one `GetItem`.
- **Access follows membership.** Every request re-checks the owner's membership of the mailbox, so removing a member cuts off their phones at once. Disabling someone in the identity provider doesn't, because app passwords don't go through it.
- **Throttling.** Failed sign-ins are counted per username and per source IP in 15-minute windows. After 10, correct passwords are refused too, but only for devices the server hasn't seen (and, for `OPTIONS`, which carries no device id, for passwords never used). A working phone therefore can't be locked out by someone guessing.
- **Device records.** The first request from each `DeviceId` creates `DEVICE#<email>` / `<deviceId>`, shown on the Phones and devices page. `Provision` hands out an empty policy and a policy key that every later command must present.
- **Autodiscover.** `/autodiscover/autodiscover.xml` answers every request with the ActiveSync URL on the host the phone asked, and reads nothing. A CloudFront function copies the viewer's `Host` to `X-Forwarded-Host`, because `Host` itself can't reach the endpoint. The example deployment publishes `_autodiscover._tcp.<domain>` as an SRV record pointing at the app's host. Whether iOS uses the SRV record is still to be confirmed; typing the server name always works.

## 23. Sync state is a snapshot per phone and folder

Exchange tracks changes per item; sesame has no change log. Instead, each phone's state for a folder is the set of messages it holds, as 17 bytes each: the ulid and a byte of read and flagged bits. Each `Sync` diffs that snapshot against the folder as it is now.

- **Where it lives:** `MBX#<id>` / `EAS#<deviceId>#<folder>` in the mail table, so purging a mailbox removes it. Nothing else in sesame had to change to produce changes: ingest, the API and the phone all just change messages.
- **Retries:** the previous sync key and snapshot are kept, so a request whose response was lost is answered again from the same starting point. A key that matches neither makes the phone start the folder again (status 3).
- **Concurrency:** writes are conditional on a revision counter, so two requests for the same folder can't both advance it. `MoveItems` edits both folders' snapshots without changing their keys, which is why the condition is the revision, not the key.
- **Limit:** both snapshots must fit in one 400 KB item, so a phone syncs at most the newest 10,000 messages of a folder (the design assumed 20,000). Larger folders would need the snapshot in S3.
- **The phone's own changes:** the folder listing comes from GSI1, which is eventually consistent. A `Sync` lays the phone's changes from the same request over the listing, so a message it just deleted or marked read isn't sent back as it was.
- **Bodies:** the original MIME from S3, truncated to the size the phone asks for, or the extracted text or HTML for clients that don't take MIME. A response stops adding messages at 8 MB of bodies and tells the phone more are available.

## 24. Push polls folder versions, and is off by default

`Ping` is a long poll. No request can reach the one environment holding a given phone's `Ping`, so ingest can't notify it. Instead the held request polls a version on each folder counter every 20 seconds.

- **The version:** ingest, every message change (flag-only changes included) and purges from Trash add 1 to `version` on `MBX#<id>` / `FOLDER#<name>`, in the same transaction as the message.
- **No missed changes:** each `Sync` records the version it read, after applying the phone's own changes and before listing the folder, and `Ping` compares against that. Mail that lands between the two still wakes the phone, and the phone's own changes don't.
- **Index lag:** if a `Sync` read the version within 3 seconds of a change, its listing may have missed that change, so `Ping` wakes the phone once more 3 seconds after it. That costs an empty round trip after such changes and nothing else.
- **Heartbeat:** 10 seconds less than CloudFront's origin read timeout (`eas_origin_read_timeout`), so 50 seconds by default. That's under EAS's own 60-second minimum, so the server lowers its minimum to match; whether iOS accepts heartbeats that short is still to be confirmed. With push on, request the CloudFront quota increase for an origin response timeout of 180 seconds and set `eas_origin_read_timeout = 180`, for 170-second heartbeats.
- **Cost:** a held `Ping` keeps one environment active, about $1.90 a month for up to 64 phones (see [cost](cost.md#phones-activesync)). That ends scale-to-zero for the eas function, so `eas_push` defaults to `false`: `Ping` isn't advertised and phones set to Push fetch on their schedule instead.

## 25. Phones send through the same routing as the web app

The web app builds MIME from a form; a phone sends finished MIME. The checks and routing that used to sit inside the API's send handler moved to `queueOutgoing` in `@sesame/core`, which both call (decision 14):

- **Same rules:** From must be one of the mailbox's addresses, recipients in local domains must exist and have room, suppressed addresses are refused, and the hourly rate limit applies. The limit is now keyed by the person's email, so web and phone share one budget.
- **One exception:** when a phone's From isn't one of the mailbox's addresses, which happens when a shared mailbox's member set up the phone with their own address, the message goes out from the mailbox's primary address instead of being refused. A refusal would leave it stuck in the phone's Outbox.
- **Headers only:** sesame takes recipients from `To`, `Cc` and `Bcc`, removes `Bcc`, replaces `Message-ID` and adds `Date` if missing. The body bytes go out as the phone built them.
- **Replies and forwards:** when the phone sends only what the user typed, sesame rebuilds the message with the original quoted, or forwarded with its attachments from S3, so attachments the phone never downloaded still go out.
- **At most once:** iOS resends with the same `ClientId` when it misses a response. A conditional put on `EASSEND#<user>#<deviceId>` / `<clientId>` (one-day TTL) turns a resend into success without a second send, and is removed again if sending fails.
