# Operations

How to watch a sesame deployment and what to do when an alarm fires. CLI commands below omit the `pnpm --filter @sesame/cli start` prefix; set `AWS_PROFILE` and `AWS_REGION` as for Terraform.

Most of these tasks can also be done in the admin console at `/admin` (`terraform output admin_url`):

- the overview shows SES status, alarm states and queue depths;
- each pipeline's page lists its dead letters and has a **Redrive** button;
- mailboxes, quotas, aliases, access and the suppression list each have a page.

Every change made there is recorded under **Activity**.

## Alarms

The `observability` module creates nine CloudWatch alarms. Each one notifies the `<name>-alarms` SNS topic when it fires and again when it clears.

To receive notifications, list addresses in `alarm_emails` and confirm the email SNS sends to each. To route alarms somewhere else, such as chat, PagerDuty or SMS, subscribe that endpoint to the `alarm_topic_arn` output.

| Alarm                        | Fires when                                                   | Start with                                        |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `<name>-ingest-dead-letters` | A received or internal message failed delivery 5 times       | [Dead-lettered messages](#dead-lettered-messages) |
| `<name>-send-dead-letters`   | Outgoing mail couldn't be handed to SES after 5 attempts     | [Dead-lettered messages](#dead-lettered-messages) |
| `<name>-events-dead-letters` | SES delivery events couldn't be recorded after 8 attempts    | [Dead-lettered messages](#dead-lettered-messages) |
| `<name>-purge-dead-letters`  | A deleted mailbox's mail couldn't be purged after 5 attempts | [Deleting mailboxes](#deleting-mailboxes)         |
| `<name>-ingest-queue-stuck`  | A message has waited over 30 minutes in the ingest queue     | [Stuck queues](#stuck-queues)                     |
| `<name>-send-queue-stuck`    | A message has waited over 30 minutes in the send queue       | [Stuck queues](#stuck-queues)                     |
| `<name>-api-errors`          | The API returned 5 or more server errors in 5 minutes        | [API errors](#api-errors)                         |
| `<name>-ses-bounce-rate`     | The account's SES bounce rate reached 4%                     | [SES reputation](#ses-reputation)                 |
| `<name>-ses-complaint-rate`  | The account's SES complaint rate reached 0.08%               | [SES reputation](#ses-reputation)                 |

Thresholds are module variables (`max_queue_age_seconds`, `api_5xx_threshold`, `ses_bounce_rate_threshold`, `ses_complaint_rate_threshold`). The SES rates cover every sender in the account and region. If other applications send from this account, set `ses_reputation_alarms = false` and watch reputation elsewhere.

Setting `monthly_budget_usd` adds an AWS Budget that notifies the same topic. It fires when the account's actual or forecast monthly cost passes that amount. The budget covers the whole account, so it fits best when sesame has an account of its own.

## Dead-lettered messages

Each pipeline (`ingest`, `send`, `events`, `purge`) has a dead-letter queue (DLQ). A message lands there after its Lambda fails it repeatedly, and it waits for 14 days. Nothing is lost while it waits. The raw MIME under `raw/` is also kept for 14 days (`raw_retention_days`), so a redrive within that window still finds it.

1. **See what's there.** `peek` leaves the messages in place:

   ```bash
   sesame queue status
   sesame queue peek ingest            # or send, events; --json prints whole bodies
   ```

2. **Find the cause.** Each failure is logged with the SQS message ID:

   ```bash
   aws logs tail /aws/lambda/sesame-ingest --since 2h --format short | grep -E '"level":"(error|warn)"'
   ```

   Usual causes:

   | Log message                                                               | Cause and fix                                                                                      |
   | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
   | `MailboxFullError: mailbox full: <id>`                                    | A recipient's mailbox is over quota. See [Full mailboxes](#full-mailboxes).                        |
   | `AccessDenied`, `ResourceNotFoundException`                               | IAM or configuration drift. Run `terraform plan`, then `terraform apply`.                          |
   | `ProvisionedThroughputExceeded`, `Throttling`, `TooManyRequestsException` | A burst exceeded a service limit. Redrive once the burst has passed.                               |
   | `InvalidJobError`                                                         | A malformed message, which a redrive won't fix. Inspect it with `peek --json`, then purge the DLQ. |

3. **Fix the cause, then redrive.** This moves every message in the DLQ back to its queue:

   ```bash
   sesame queue redrive ingest
   sesame queue status                 # dead drops to 0 within a minute or two
   ```

Redrives are safe to repeat:

- **ingest:** message IDs are deterministic. Mailboxes that already have the message treat it as a duplicate, and the rest get it now.
- **send:** a lock per job means SES never sends a message twice.
  - If an earlier attempt recorded an SES message ID, the redrive only finishes the bookkeeping.
  - If an attempt died partway through sending, the redrive marks the recipients as failed rather than risk a duplicate. The sender then sees a failed status on the Sent copy and can send the message again.
- **events:** a delivery status never moves backwards. Replaying an event that was already applied changes nothing.

To redrive from the console instead: open the DLQ in SQS, choose **Start DLQ redrive**, and pick **Redrive to source queue(s)**.

## Stuck queues

A message older than 30 minutes in the ingest or send queue means its consumer isn't keeping up or isn't running. Check, in order:

1. **The Lambda's errors and throttles** in CloudWatch: `sesame-ingest` or `sesame-sender`.
2. **Whether the event source mapping is enabled:**

   ```bash
   aws lambda list-event-source-mappings --function-name sesame-ingest --query 'EventSourceMappings[].State'
   ```

3. **For send:** SES may be throttling the account. Check `aws sesv2 get-account`. While the account is in the SES sandbox, sending is limited to 1 message per second and 200 a day. Raising the account's sending quota or requesting production access fixes this.

Ingest retries a failing message for about 30 minutes (5 attempts, 6 minutes apart) before dead-lettering it, so this alarm often fires just before a dead-letter alarm.

## API errors

The API logs one JSON line per error, with the request path. Web Function logs reach `/aws/lambda/web/<name>-api.local` within seconds; the main log group gets them only hours later:

```bash
aws logs tail /aws/lambda/web/sesame-api.local --since 30m --format short | grep '"level":"error"'
```

A burst of errors right after a deploy usually comes from the new revision. To roll back, check out the previous commit, run `pnpm build`, then `terraform apply`: the endpoint moves to a new revision built from the old code.

## Full mailboxes

`sesame mailbox quota <address> <MB>` sets a quota, and `sesame mailbox quota <address> none` removes it. `sesame mailbox list` shows usage. Usage counts each message's raw size, and purging mail from Trash frees it.

A mailbox at or over its quota stops taking new mail. The message that fills it is still accepted, so usage can overshoot the quota by one message. When a mailbox is full:

- **Its users** see a red "Mailbox full" note in the folder rail, and the API refuses to send from it.
- **Local senders** get an error naming the full mailbox, and nothing is sent.
- **Mail from outside** is not bounced. Ingest fails the message, SQS retries it for about 30 minutes, and then it waits in the ingest DLQ, which fires `<name>-ingest-dead-letters`. Other recipients of the same message get it normally.

To deliver the held mail, free space or raise the quota, then redrive:

```bash
sesame mailbox quota alice@example.com 2048
sesame queue redrive ingest
```

The redrive must happen within 14 days, or the held mail is lost.

## Deleting mailboxes

Delete a mailbox from its page in the admin console (**Delete mailbox…**, then type its address to confirm), or with `sesame mailbox delete <address> --yes`. Deletion can't be undone:

1. **Right away:** one transaction removes the mailbox, its addresses and aliases, everyone's access, and any catch-all that pointed at it, and records a purge marker. Mail to its addresses is dropped from then on, unless the domain has another catch-all, and its addresses can be reused immediately.
2. **Within a minute:** the `<name>-purge` Lambda deletes its messages, folder counters, search index and stored objects. It refuses to touch a mailbox that still exists in the directory.
3. **15 minutes later:** a final pass catches anything a delivery already in flight wrote after the first pass, then removes the purge marker.

Until the marker is gone, the mailbox is listed under **Being deleted** on the console's Mailboxes page. If it stays there, the purge failed: check the `<name>-purge` logs and the purge dead-letter queue, then use **Restart purge** or `sesame queue redrive purge`. A purge is safe to repeat.

Mail the mailbox had already queued to outside recipients is still sent. SES events for it are dropped, because its Sent copy no longer exists.

Phones syncing the mailbox stop at once, because their owners' access goes with it. Their app passwords stay on each owner's **Phones and devices** page, marked "A mailbox you no longer have access to", until the owner revokes them.

## SES reputation

SES puts an account under review at a 5% bounce rate or a 0.1% complaint rate, and may pause sending at 10% or 0.5%. The alarms fire a little earlier.

1. **Find the cause.** Sent copies show per-recipient status in the app. The suppression list holds every hard bounce and complaint:

   ```bash
   aws dynamodb scan --table-name sesame-directory --filter-expression "begins_with(pk, :s)" \
     --expression-attribute-values '{":s":{"S":"SUPPRESS#"}}' --query 'Items[].[address.S,reason.S,at.S]' --output text
   ```

2. **Stop the source.** A user sending to an old list, or a compromised account, is the usual culprit. Per-user sending is limited to `send_rate_limit` messages an hour. To cut off one user right away, revoke their membership with `sesame member revoke`.
3. **Check the account's standing** in the SES console under **Reputation metrics**. If AWS opened a review, answer it from the console.

Suppressed addresses stay blocked until you delete their item. Only do that once you know the address works again:

```bash
aws dynamodb delete-item --table-name sesame-directory --key '{"pk":{"S":"SUPPRESS#bob@example.org"},"sk":{"S":"META"}}'
```

## SES production access

New SES accounts start in the sandbox. There, mail goes only to verified identities and the mailbox simulator, at most 200 messages a day. Receiving mail and delivering between local mailboxes work in the sandbox. Sending to anyone else needs production access.

Request it in the SES console under **Account dashboard → Request production access**, or from the CLI:

```bash
aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL \
  --website-url https://mail.example.com --contact-language EN \
  --use-case-description "Person-to-person mail for the staff of example.com, sent from a self-hosted webmail (sesame). Users sign in through our IdP. Recipients are people our staff correspond with; there are no lists or marketing. Hard bounces and complaints are added to a suppression list automatically, and each user can send at most 200 messages an hour."
```

AWS usually answers within a day. Reviewers want to know:

- who sends and to whom;
- that you don't send to purchased lists;
- how you handle bounces and complaints.

sesame suppresses hard bounces and complaints automatically and rate-limits each user, so say so. `sesame domain status <domain>` should report the domain as verified, with DKIM and MAIL FROM set up, before you apply.

Once access is granted, `aws sesv2 get-account` shows `ProductionAccessEnabled: true` and the higher sending quota.

## Phones (ActiveSync)

Phones sync through the `<name>-eas` Web Function, behind the app's CloudFront distribution. Their server name is the app's own host (the `eas_server` output). Its logs carry one line per request, with the command, a short hash of the device id and the duration, and never credentials, addresses or message content:

```bash
aws logs tail /aws/lambda/web/sesame-eas.local --since 30m --format short
```

There's no alarm for this function, to stay within the CloudWatch free tier. Check its logs when someone reports trouble.

### A phone can't sign in

- **Wrong password or username:** the username must be the person's own email, `DOMAIN\user`, or the bare local part, and the app password must be for a mailbox they're still a member of. Logs show `ActiveSync sign-in failed` with `reason` `password` or `username`, or `ActiveSync sign-in without mailbox access`.
- **Locked out:** after 10 failed sign-ins for one username or from one IP within 15 minutes, `ActiveSync sign-in refused: too many failures` is logged and new devices are turned away until the window ends. Phones that already signed in keep working. Nothing needs clearing: the counters expire on their own.
- **Server name:** iOS needs the `eas_server` output as the server, unless Autodiscover finds it. With `route53_zone_id` set, the example creates the `_autodiscover._tcp.<domain>` SRV record; otherwise it's in the `dns_records` output.
- **From outside:** Microsoft's Remote Connectivity Analyzer (testconnectivity.microsoft.com) has an Exchange ActiveSync test that runs against any public server, using a real app password.

### Offboarding and lost phones

- **Someone leaves:** remove their access to each mailbox in the admin console or with `sesame member revoke <mailbox address> <login email>`. Their phones stop on the next request. Disabling them in your identity provider is not enough, because app passwords don't go through it.
- **A lost phone:** the owner revokes its app password on the **Phones and devices** page, which ends its sync at once. There's no remote wipe.

### Push

`eas_push` decides whether phones may use push. Off (the default), phones set to Push fetch on their own schedule, every 15 minutes at most. On, one environment stays active while any phone waits, about $1.90 a month (see [cost](cost.md#phones-activesync)). Changing it creates a new revision; phones notice at their next `OPTIONS` request, which iOS sends from time to time, or when the account is added again.

New mail should reach a phone set to Push within about 20 seconds plus one sync. If it doesn't, check that the phone is set to Push for this account (**Settings › Apps › Mail › Mail Accounts › Fetch New Data**), and that the logs show `Ping` requests lasting the full heartbeat (`eas_origin_read_timeout` less 10 seconds) rather than returning at once.

Short heartbeats mean more requests and more battery use on the phone. To lengthen them, request an increase of the CloudFront quota **Response timeout per origin** to 180 seconds in Service Quotas, then set `eas_origin_read_timeout = 180` in `terraform.tfvars` and apply.

## Backups and recovery

- **Mail metadata:** the mail and directory tables have DynamoDB deletion protection unless `force_destroy` is set. Point-in-time recovery is off by default to keep idle cost near zero. Turn it on with `point_in_time_recovery = true` on the storage module; it costs about $0.20 per GB-month.
- **Message content:** the mail bucket holds every message's raw MIME (`mbx/<mailbox>/<message>/message.eml`). The bucket isn't versioned, so a message purged from Trash is gone for good. For backups, enable S3 versioning, or replicate the bucket to another account.
- **Rebuilding the search index:** `sesame search reindex` rebuilds it from the tables and bucket at any time.

## Updating

```bash
git pull
pnpm install && pnpm build
cd infra/examples/single-domain && terraform apply
cd - && scripts/deploy-web.sh
```

Terraform replaces the API revision before deleting the old one, so the API stays up during a deploy. Lambdas switch to the new code on their next invocation. Queued messages wait in SQS and are processed by whichever version picks them up.
