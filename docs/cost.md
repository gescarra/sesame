# Cost model

sesame uses only pay-per-use services, so cost follows mail volume and how long people keep the app open. These estimates use us-east-1 list prices as of October 2026; check the AWS pricing pages before relying on them.

## Idle: about $0.50 a month

With no mail and no one signed in, nothing runs. What remains:

| Item                                  | Monthly               |
| ------------------------------------- | --------------------- |
| Route 53 hosted zone (if you use one) | $0.50                 |
| S3 storage for stored mail            | $0.023 per GB         |
| DynamoDB storage                      | free up to 25 GB      |
| 9 CloudWatch alarms                   | free (10 per account) |
| SSM parameter, SQS, SNS, Cognito, KMS | $0                    |

The alarms cost $0.10 each once the account has more than 10 alarm metrics. AWS Budgets doesn't charge for an account's first two budgets.

## Per message

Assume a typical 50 KB message whose search index holds 120 tokens.

| Step                                                 | Inbound       | Outbound (external)                     | Internal (local to local) |
| ---------------------------------------------------- | ------------- | --------------------------------------- | ------------------------- |
| SES receiving ($0.10/1k + $0.09/1k 256 KB chunks)    | $0.00019      | –                                       | –                         |
| SES sending ($0.10/1k + $0.12/GB attachments)        | –             | $0.00010                                | –                         |
| DynamoDB writes (about 135 write units per delivery) | $0.00008      | $0.00009 (Sent copy and status updates) | $0.00017 (two deliveries) |
| S3 requests (3–5 PUT/COPY)                           | $0.00002      | $0.00002                                | $0.00003                  |
| Lambda, SQS, SNS                                     | free tier     | free tier                               | free tier                 |
| **Total**                                            | **≈ $0.0003** | **≈ $0.0002**                           | **≈ $0.0002**             |

About **$0.30 per 1,000 received messages** and **$0.20 per 1,000 sent**. Messages with attachments cost more:

- **SES receiving:** each 256 KB chunk adds $0.00009.
- **SES sending:** attachments add $0.12 per GB.
- **S3 storage:** each message is stored twice, as raw MIME and as its extracted parts.

### Where the DynamoDB writes go

Each delivery writes:

- **The delivery transaction:** about 13 write units. It covers the message item, folder counter, mailbox usage and Message-ID map; transactional writes cost double, and the two indexes add a little more.
- **One search index item per token:** usually 100–200 write units for a message with a body, and about 25 for headers only.

The search index is therefore most of the per-message DynamoDB cost. Setting `search_index_body = false` cuts it by about 80%, at the cost of not finding words in message bodies. On-demand writes cost $0.625 per million units, so 1,000 messages with bodies indexed cost about $0.08.

## Web app and API

The API runs on a Lambda Web Function. It bills for active CPU time and for memory while an execution environment is active, and it scales to zero when no one uses it. On this project's test deployment, the API used:

- **Memory:** about 200 MB per environment.
- **CPU:** about 100 ms of active CPU per request. Over one week, the API used 46 seconds of CPU for 436 requests, and even the busiest hour (232 requests) averaged 90 ms. That figure includes environment start-ups, so steady traffic should cost less per request, but plan with 100 ms.

Rates reported for Web Functions are:

- $0.0000277 per vCPU-second;
- $0.0000037 per GB-second of memory;
- $0.30 per million requests.

AWS's own pricing page is the reference.

While anyone has sesame open, it polls folder counts every 60 seconds, which keeps an environment active. One environment active for a 9-hour workday, 22 days a month, costs about $0.50 in memory. Each user adds about 20,000 requests a month, or about $0.06 in CPU and requests.

CloudFront stays within its free tier (1 TB and 10 million requests a month) for any realistic mail volume. Cognito charges nothing for the first 50 federated (SAML or OIDC) monthly active users, then $0.015 each. Native Cognito users on the Lite tier are free up to 10,000.

## Phones (ActiveSync)

Phones reach the `eas` Web Function, which bills like the API: active CPU, memory while an environment is active, and requests. These figures are estimates from the rates above and the API's measured 100 ms and 200 MB. They haven't been measured for ActiveSync yet.

### Without push: a few cents per phone

iPhone Mail set to **Fetch** checks every 15 minutes at most, or about 2,900 times a month, with one `Sync` each time. More happen while Mail is open.

| Item                          | Per phone, monthly | Assumption                                                         |
| ----------------------------- | ------------------ | ------------------------------------------------------------------ |
| Web Function CPU and requests | about $0.01        | 2,900 requests at 100 ms                                           |
| Environment memory            | under $0.03        | 1–10 s of active environment per fetch (to be measured)            |
| DynamoDB reads                | $0.01–0.70         | Each `Sync` reads the whole synced window of the folder; see below |

Every `Sync` lists the messages in the window the phone syncs (iOS's **Mail Days to Sync**), so the read cost grows with that window. Message items are 1–2 KB, and reads cost $0.125 per million read units:

- **1 week, about 100 messages:** about 20 read units per `Sync`, under $0.01 a month.
- **No limit, 10,000 messages (the most a phone syncs per folder):** about 1,900 read units per `Sync`, about $0.70 a month.

A phone's first sync of a folder also reads each message's MIME from S3, about $0.0004 per 1,000 messages in requests.

### With push: about $1.90 a month, shared

With `eas_push = true` and a phone set to **Push**, the phone keeps a `Ping` request open around the clock. Each one lasts 10 seconds less than CloudFront's origin read timeout (`eas_origin_read_timeout`): 50 seconds by default, or 170 with the timeout raised to 180. That keeps one environment active all month:

| Item                                     | Monthly                                           |
| ---------------------------------------- | ------------------------------------------------- |
| Environment memory, all month            | about $1.90 (0.2 GB × 2.6 million s × $0.0000037) |
| Folder checks (one query every 20 s)     | under $0.01 per phone                             |
| CPU for those checks and `Ping` requests | about $0.05 per phone at 50 s, $0.02 at 170 s     |

One environment holds up to 64 waiting phones, so the $1.90 is shared; more environments start only past that. On classic Lambda, which bills wall-clock time, each waiting phone would cost about $4.30 a month instead.

Two things to confirm on a real deployment before relying on the figure:

- whether an environment that holds only idle `Ping` requests bills memory all month, as assumed here;
- how many environments iOS's request pattern keeps active.

To measure it, enable push for one phone for a week and compare the Web Function's cost in Cost Explorer (filtered by `app = sesame`) with a week without.

If push isn't worth it, leave `eas_push` off. Phones set to Push then fall back to fetching.

## A worked example

Take 10 users with 5,000 received and 2,000 sent messages a month, 1,500 of them to outside recipients.

| Item                                     | Monthly         |
| ---------------------------------------- | --------------- |
| SES receiving                            | $0.95           |
| SES sending                              | $0.15           |
| DynamoDB writes and reads                | $0.75           |
| S3 requests and storage (grows ~1 GB/mo) | $0.15           |
| API (Web Function)                       | $1.10           |
| Lambda, SQS, SNS, CloudFront, Cognito    | $0 (free tiers) |
| CloudWatch Logs                          | $0.05           |
| Route 53 hosted zone                     | $0.50           |
| **Total**                                | **≈ $3.65**     |

With five of them also on iPhones set to Fetch, add about $0.15. With push enabled and used, add about $2.

## Keeping an eye on it

- **Budget alert:** set `monthly_budget_usd` to be notified when actual or forecast spending passes a limit; see [operations](operations.md#alarms).
- **Cost by resource:** every resource carries the tag `app = sesame`. To break costs down by it, activate `app` as a cost allocation tag in the Billing console. Cost Explorer can filter by the tag about a day later.
- **Search cost:** the index's share of the cost shows in DynamoDB write units. For a mailbox-level view, compare the count of search items with the count of messages in the mail table.
