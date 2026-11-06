# Inbound mail: SES receipt rule → S3 (raw/inbound/) + SNS notification → SQS → ingest Lambda.
#
# SES writes the raw MIME to S3 and publishes a notification carrying the envelope
# recipients and verdicts. The stored MIME has no envelope, so Bcc recipients are only
# known from the notification; that's why ingest consumes it instead of S3 events.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  region         = data.aws_region.current.region
  account_id     = data.aws_caller_identity.current.account_id
  partition      = data.aws_partition.current.partition
  rule_set_name  = "${var.name}-rules"
  rule_name      = "${var.name}-inbound"
  rule_arn       = "arn:${local.partition}:ses:${local.region}:${local.account_id}:receipt-rule-set/${local.rule_set_name}:receipt-rule/${local.rule_name}"
  inbound_prefix = "raw/inbound/"
}

# --- SNS topic SES publishes receipt notifications to ---

resource "aws_sns_topic" "inbound" {
  name = "${var.name}-inbound"
  tags = var.tags
}

resource "aws_sns_topic_policy" "inbound" {
  arn = aws_sns_topic.inbound.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSESPublish"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.inbound.arn
      Condition = {
        StringEquals = { "AWS:SourceAccount" = local.account_id }
        ArnLike      = { "AWS:SourceArn" = local.rule_arn }
      }
    }]
  })
}

# --- Ingest queue ---

resource "aws_sqs_queue" "ingest_dlq" {
  name                      = "${var.name}-ingest-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "ingest" {
  name                       = "${var.name}-ingest"
  visibility_timeout_seconds = var.lambda_timeout_seconds * 6
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true
  tags                       = var.tags

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_policy" "ingest" {
  queue_url = aws_sqs_queue.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowInboundTopic"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.ingest.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.inbound.arn } }
    }]
  })
}

resource "aws_sns_topic_subscription" "ingest" {
  topic_arn = aws_sns_topic.inbound.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.ingest.arn
  # The SQS body is the SES notification itself, not an SNS envelope.
  raw_message_delivery = true
}

# --- Mail bucket policy (SES writes, TLS only) ---

resource "aws_s3_bucket_policy" "mail" {
  bucket = var.mail_bucket_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowSESPuts"
        Effect    = "Allow"
        Principal = { Service = "ses.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${var.mail_bucket_arn}/${local.inbound_prefix}*"
        Condition = {
          StringEquals = { "AWS:SourceAccount" = local.account_id }
          ArnLike      = { "AWS:SourceArn" = local.rule_arn }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [var.mail_bucket_arn, "${var.mail_bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

# --- Receipt rules ---

resource "aws_ses_receipt_rule_set" "this" {
  rule_set_name = local.rule_set_name
}

resource "aws_ses_receipt_rule" "inbound" {
  name          = local.rule_name
  rule_set_name = aws_ses_receipt_rule_set.this.rule_set_name
  recipients    = [var.domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = var.require_tls ? "Require" : "Optional"

  s3_action {
    position          = 1
    bucket_name       = var.mail_bucket_name
    object_key_prefix = local.inbound_prefix
    topic_arn         = aws_sns_topic.inbound.arn
  }

  # SES checks bucket and topic permissions when the rule is created.
  depends_on = [aws_s3_bucket_policy.mail, aws_sns_topic_policy.inbound]
}

# Only one rule set can be active per account and region. Set activate_rule_set = false
# if this account already receives mail through another rule set, and add the rule there.
resource "aws_ses_active_receipt_rule_set" "this" {
  count         = var.activate_rule_set ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.this.rule_set_name
}

# --- Ingest Lambda ---

data "archive_file" "ingest" {
  type        = "zip"
  source_dir  = var.ingest_source_dir
  output_path = "${path.root}/.build/ingest.zip"
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${var.name}-ingest"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_iam_role" "ingest" {
  name = "${var.name}-ingest"
  tags = var.tags
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ingest" {
  name = "ingest"
  role = aws_iam_role.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "Logs"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = "${aws_cloudwatch_log_group.ingest.arn}:*"
        },
        {
          Sid      = "Queue"
          Effect   = "Allow"
          Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
          Resource = aws_sqs_queue.ingest.arn
        },
        {
          Sid      = "ReadRaw"
          Effect   = "Allow"
          Action   = "s3:GetObject"
          Resource = "${var.mail_bucket_arn}/raw/*"
        },
        {
          Sid      = "WriteMailboxes"
          Effect   = "Allow"
          Action   = "s3:PutObject"
          Resource = "${var.mail_bucket_arn}/mbx/*"
        },
        {
          Sid      = "Directory"
          Effect   = "Allow"
          Action   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"]
          Resource = var.directory_table_arn
        },
        {
          Sid      = "Mail"
          Effect   = "Allow"
          Action   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:BatchWriteItem"]
          Resource = var.mail_table_arn
        },
      ],
      var.kms_key_arn == null ? [] : [{
        Sid      = "MailBucketKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = var.kms_key_arn
      }],
    )
  })
}

resource "aws_lambda_function" "ingest" {
  function_name    = "${var.name}-ingest"
  description      = "Delivers inbound and internal mail to sesame mailboxes"
  role             = aws_iam_role.ingest.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "handler.handler"
  filename         = data.archive_file.ingest.output_path
  source_code_hash = data.archive_file.ingest.output_base64sha256
  memory_size      = var.lambda_memory_mb
  timeout          = var.lambda_timeout_seconds
  tags             = var.tags

  environment {
    variables = {
      MAIL_BUCKET       = var.mail_bucket_name
      MAIL_TABLE        = var.mail_table_name
      DIRECTORY_TABLE   = var.directory_table_name
      SEARCH_INDEX_BODY = tostring(var.search_index_body)
      NODE_OPTIONS      = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.ingest.name
  }
}

resource "aws_lambda_event_source_mapping" "ingest" {
  event_source_arn        = aws_sqs_queue.ingest.arn
  function_name           = aws_lambda_function.ingest.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.max_concurrency
  }
}
