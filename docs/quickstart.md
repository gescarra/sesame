# Quickstart

This deploys storage, the directory, the SES domain identity, the inbound pipeline (M1), sign-in plus the read API behind CloudFront (M2), the web app (M3), sending (M4), search (M5), and alarms (M6).

## Prerequisites

- An AWS account and credentials (`AWS_PROFILE` or environment variables).
- A domain whose DNS you control, ideally in Route 53. Its MX record will point at SES, so use a domain or subdomain that doesn't already receive mail elsewhere.
- Node.js 24+, pnpm and Terraform 1.10+ (or OpenTofu).
- An S3 bucket for Terraform state.

SES receiving works while the account is still in the SES sandbox. Sending to arbitrary recipients (M4) needs production access.

## 1. Build the Lambda bundles

```bash
pnpm install
pnpm build
```

## 2. Deploy

```bash
cd infra/examples/single-domain
cp terraform.tfvars.example terraform.tfvars        # set domain, region, route53_zone_id, sign-in
cp backend.hcl.example backend.hcl                  # set your state bucket
terraform init -backend-config=backend.hcl
terraform apply
```

Sign-in needs at least one SAML or OIDC IdP in `identity_providers`, or `allow_cognito_users = true` (see the next section). The managed login domain, app client and callback URL are created for you.

### Custom domain for the web app

By default the app and API are served at the distribution's `*.cloudfront.net` name. To use your own hostname instead, set `web_domain`, for example `mail.example.com`.

- **With the name in Route 53:** if `web_domain` is in the `route53_zone_id` zone (or in `web_route53_zone_id`), Terraform does the rest:
  - issues an ACM certificate in us-east-1 and validates it through DNS;
  - attaches the certificate and the name to CloudFront;
  - creates the `A` and `AAAA` alias records.
- **With DNS elsewhere:** request a us-east-1 ACM certificate for the name yourself and pass it as `web_certificate_arn`. Then point the name at the `cloudfront_domain_name` output with a `CNAME`.

The web app and the API share the domain, because `/api/*` is served by the same distribution. Sign-in callbacks, upload CORS and the API's redirects follow it. The `cloudfront.net` name keeps working but redirects to `web_domain`, where the session cookie lives. Cognito's managed login page stays on its own `*.amazoncognito.com` domain.

If this account and region already use an active SES receipt rule set, set `activate_rule_set = false`. Only one rule set can be active at a time, so activating sesame's would replace the existing one.

## 3. DNS

With `route53_zone_id` set, Terraform creates the records. Otherwise, publish the `dns_records` output:

| Record                                                     | Purpose                           |
| ---------------------------------------------------------- | --------------------------------- |
| `MX` on the domain → `inbound-smtp.<region>.amazonaws.com` | Receive mail through SES          |
| 3 × `CNAME` `<token>._domainkey`                           | Easy DKIM signing                 |
| `MX` + `TXT` on `bounce.<domain>`                          | Custom MAIL FROM, so SPF aligns   |
| `TXT` on `_dmarc`                                          | DMARC policy (starts at `p=none`) |
| `SRV` on `_autodiscover._tcp` → the ActiveSync endpoint    | Phones find the server by address |

Check verification, which can take a few minutes after DNS propagates:

```bash
export SESAME_DIRECTORY_TABLE=$(terraform output -raw directory_table)
pnpm --filter @sesame/cli start domain status example.com
```

## 4. Create mailboxes

The `pnpm --filter @sesame/cli start` prefix is omitted below:

```bash
sesame domain add example.com
sesame mailbox add alice@example.com --name "Alice"
sesame alias add hello@example.com alice@example.com
sesame domain catch-all example.com alice@example.com   # optional
sesame mailbox list
```

`mailbox add` makes the address its own owner. To have someone else sign in to it, use `--owner them@idp-domain.com` or `sesame member grant`.

## 5. Send a test message

Send a message from any external account to `alice@example.com`, then check that it arrived:

```bash
aws dynamodb query --table-name "$(terraform output -raw mail_table)" \
  --key-condition-expression "pk = :p and begins_with(sk, :m)" \
  --expression-attribute-values '{":p":{"S":"MBX#<mailbox id>"},":m":{"S":"MSG#"}}'
aws s3 ls "s3://$(terraform output -raw mail_bucket)/mbx/" --recursive
```

If nothing arrives:

- Ingest logs are in `/aws/lambda/sesame-ingest`.
- Messages that failed 5 times are in the DLQ (`terraform output ingest_dlq_url`).
- Unknown recipients are logged as `ignoring non-local recipient`.

## 6. Sign in and read mail through the API

Without an IdP, create a native Cognito user (with `allow_cognito_users = true`):

```bash
aws cognito-idp admin-create-user --user-pool-id "$(terraform output -raw cognito_user_pool_id)" \
  --username you@example.org --user-attributes Name=email,Value=you@example.org Name=email_verified,Value=true
```

Cognito emails a temporary password. Then give that email access to a mailbox:

```bash
sesame member grant alice@example.com you@example.org
```

Open `$(terraform output -raw url)/api/auth/login?return=/api/me` in a browser and sign in. You land on `/api/me`, which lists your mailboxes. From there, for example:

- `/api/mailboxes/<id>/folders`: folder counts.
- `/api/mailboxes/<id>/messages?folder=inbox`: newest first, with `cursor` for the next page. Add `unread=1`, or use `flagged=1` instead of `folder`.
- `/api/mailboxes/<id>/messages/<messageId>`: metadata and the sanitized body.
- `/api/mailboxes/<id>/messages/<messageId>/attachments/<partId>` and `/raw`: downloads, through a 5-minute presigned URL.

`PATCH`, `DELETE` and `POST …/messages/batch` also need an `X-Requested-With` header, as a CSRF guard.

The API reads its CloudFront and Cognito settings from the SSM parameter `/<name>/api/config` once per execution environment. If you change them (for example, by adding an IdP), new environments pick them up; to force it, redeploy the API.

API logs land first in `<api_log_group>.local` and are copied into `terraform output -raw api_log_group` later, sometimes hours later. Look in `.local` while debugging.

## 7. Publish the web app

```bash
scripts/deploy-web.sh                      # builds packages/web and uploads it
```

The script reads `site_bucket`, `distribution_id` and `url` from `infra/examples/single-domain`; pass another Terraform directory as its argument. Hashed assets are cached for a year and `index.html` is revalidated on every load, so a deploy shows up on the next page load.

Open the `url` output and sign in. You land in the first mailbox you're a member of.

To work on the UI locally, run the API on port 8080 (or any server that answers `/api/*`) and start Vite:

```bash
pnpm --filter @sesame/web dev
```

## 8. Send mail

Use **New message**, **Reply**, **Reply all** or **Forward** in the app.

- **Local recipients:** mail to any mailbox in the directory is delivered internally, without going through SES.
- **Everyone else:** SES delivers the message. The Sent copy shows each recipient's status as SES reports back: sent, delivered, delayed, bounced or marked as spam.
- **Blocked addresses:** an address that bounces permanently or files a complaint is suppressed. The API then refuses to send to it until you delete its `SUPPRESS#<address>` item from the directory table.
- **Rate limit:** each user can send 200 messages an hour (`send_rate_limit`).

**SES sandbox.** New SES accounts can only send to verified identities and the [mailbox simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html#send-email-simulator). Until you request production access (see [operations](operations.md#ses-production-access)), other external recipients fail with "Email address is not verified". Sending to `success@simulator.amazonses.com` and `bounce@simulator.amazonses.com` exercises the whole path.

If a send gets stuck, check the `sesame-sender` and `sesame-ses-events` logs, and `sesame queue status`.

## 9. Search

Type in the search box above the message list. Every word must match, and each word matches by prefix, so `rep` finds "report". Accents and case don't matter. The index covers subject, sender, recipients, attachment names and the first 8 KB of the body.

| Operator                                    | Meaning                                                               |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `from:bob`, `to:alice@example.com`, `cc:`   | Only in the sender or recipient fields                                |
| `subject:"q3 plans"`, `body:`, `file:`      | Only in the subject, body or attachment names                         |
| `has:attachment`, `is:unread`, `is:flagged` | Filters                                                               |
| `in:sent`, `in:anywhere`                    | Junk and Trash are left out unless you name them or use `in:anywhere` |

Ingest indexes mail as it arrives. To index mail stored before search existed, or after changing `search_index_body`:

```bash
SESAME_MAIL_BUCKET="$(terraform output -raw mail_bucket)" sesame search reindex [mailbox address]
```

Body tokens are most of the index's write cost. Set `search_index_body = false` on the inbound module to index headers and attachment names only.

## 10. Alarms, quotas and operations

Set `alarm_emails` in `terraform.tfvars`, apply, and confirm the email SNS sends to each address. Eight alarms then report dead-lettered mail, stuck queues, API errors and SES reputation problems. `monthly_budget_usd` adds a cost alert.

```bash
sesame mailbox quota alice@example.com 2048     # MB; "none" removes it
sesame queue status                             # waiting, in flight and dead messages per pipeline
sesame queue peek ingest                        # look at dead-lettered messages
sesame queue redrive ingest                     # retry them once the cause is fixed
```

[operations.md](operations.md) has a runbook for each alarm, plus full mailboxes, the suppression list, SES production access, backups and updates. [cost.md](cost.md) breaks down what a deployment costs.

## 11. Admin console

The admin console is at `/admin` on the app's domain (`terraform output admin_url`). It covers domains, mailboxes (including deleting them), quotas, aliases, access, the suppression list, queues and alarms, and records every change. Only members of the `sesame-admins` Cognito group (`terraform output admin_group`) can open it.

Add an administrator:

```bash
aws cognito-idp admin-add-user-to-group --user-pool-id "$(terraform output -raw cognito_user_pool_id)" \
  --group-name "$(terraform output -raw admin_group)" --username <username>
```

- **Native Cognito users:** the username is the one you created them with.
- **Federated users:** they must sign in once first. Their username then looks like `<idp name>_<id>`; find it with `aws cognito-idp list-users`.

Group membership is read at sign-in, so a new administrator must sign in again. The console's **Sign in again** link does that. Removing someone from the group takes effect at their next sign-in, which is within 12 hours.

## 12. Phones (ActiveSync)

iPhone Mail can sync a sesame mailbox as an Exchange account: mail, read and flagged state, moves and deletes, and sending. Calendar and contacts aren't synced.

1. In the web app, open **Phones and devices** below the folders, choose the mailbox and a label, and create an app password. It's shown once.
2. On the iPhone, open **Settings › Apps › Mail › Mail Accounts › Add Account › Microsoft Exchange**. Enter the mailbox's address, tap **Next**, then **Configure Manually**, and enter the app password.
3. If the phone asks for a server, enter the app's host name (`terraform output -raw eas_server`), leave **Domain** empty, and use your email as the username. The Phones and devices page shows the same values.
4. Turn on **Mail** only.

The phone then fetches new mail on its schedule, every 15 minutes at most. For push, so new mail arrives within about a minute, set `eas_push = true` in `terraform.tfvars` and apply, then set the account to **Push** under **Settings › Apps › Mail › Mail Accounts › Fetch New Data**. Push keeps one Web Function environment active while any phone waits, about $1.90 a month ([cost](cost.md#phones-activesync)).

Each app password opens one mailbox; create one per mailbox. Revoking it on that page ends sync on its phones. To cut off someone who leaves, remove their mailbox access: their phones stop at once. [operations.md](operations.md#phones-activesync) covers sign-in problems, lockouts and push.
