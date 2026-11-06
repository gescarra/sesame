# Outbound mail: the send queue and the sender Lambda that hands messages to SES, and the path
# that brings SES delivery events back (configuration set -> SNS -> SQS -> ses-events Lambda).
# Mail between local mailboxes never comes through here: the API delivers it through ingest.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  region         = data.aws_region.current.region
  account_id     = data.aws_caller_identity.current.account_id
  config_set_arn = "arn:aws:ses:${local.region}:${local.account_id}:configuration-set/${var.configuration_set_name}"
}

# --- Send queue ---------------------------------------------------------------

resource "aws_sqs_queue" "send_dlq" {
  name                      = "${var.name}-send-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "send" {
  name                       = "${var.name}-send"
  visibility_timeout_seconds = var.lambda_timeout_seconds * 6
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  tags                       = var.tags

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.send_dlq.arn
    maxReceiveCount     = 5
  })
}

# --- Sender Lambda ------------------------------------------------------------

data "archive_file" "sender" {
  type        = "zip"
  source_dir  = var.sender_source_dir
  output_path = "${path.root}/.build/sender.zip"
}

resource "aws_cloudwatch_log_group" "sender" {
  name              = "/aws/lambda/${var.name}-sender"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_iam_role" "sender" {
  name = "${var.name}-sender"
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

resource "aws_iam_role_policy" "sender" {
  name = "sender"
  role = aws_iam_role.sender.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "Logs"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = "${aws_cloudwatch_log_group.sender.arn}:*"
        },
        {
          Sid      = "Queue"
          Effect   = "Allow"
          Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
          Resource = aws_sqs_queue.send.arn
        },
        {
          Sid      = "ReadOutbound"
          Effect   = "Allow"
          Action   = "s3:GetObject"
          Resource = "${var.mail_bucket_arn}/raw/outbound/*"
        },
        {
          # SES v2 SendEmail with raw content is authorized as ses:SendRawEmail.
          Sid      = "Send"
          Effect   = "Allow"
          Action   = ["ses:SendEmail", "ses:SendRawEmail"]
          Resource = [var.identity_arn, local.config_set_arn]
        },
        {
          Sid      = "Mail"
          Effect   = "Allow"
          Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
          Resource = var.mail_table_arn
        },
        {
          # Whether a mailbox still exists, when its Sent copy is missing.
          Sid       = "MailboxExists"
          Effect    = "Allow"
          Action    = "dynamodb:GetItem"
          Resource  = var.directory_table_arn
          Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["MBX#*"] } }
        },
      ],
      var.kms_key_arn == null ? [] : [{
        Sid      = "MailBucketKey"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = var.kms_key_arn
      }],
    )
  })
}

resource "aws_lambda_function" "sender" {
  function_name    = "${var.name}-sender"
  description      = "Sends sesame mail to external recipients through SES"
  role             = aws_iam_role.sender.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "handler.handler"
  filename         = data.archive_file.sender.output_path
  source_code_hash = data.archive_file.sender.output_base64sha256
  memory_size      = 512
  timeout          = var.lambda_timeout_seconds
  tags             = var.tags

  environment {
    variables = {
      MAIL_TABLE            = var.mail_table_name
      DIRECTORY_TABLE       = var.directory_table_name
      SES_CONFIGURATION_SET = var.configuration_set_name
      NODE_OPTIONS          = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.sender.name
  }
}

resource "aws_lambda_event_source_mapping" "sender" {
  event_source_arn = aws_sqs_queue.send.arn
  function_name    = aws_lambda_function.sender.arn
  # One message per invocation keeps SES throttling retries per message.
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  # Keeps the send rate near the SES quota (1/s in the sandbox, more in production).
  scaling_config {
    maximum_concurrency = var.sender_max_concurrency
  }
}

# --- SES events ---------------------------------------------------------------

# Not KMS-encrypted: SES can only publish to an encrypted topic through a customer-managed key.
resource "aws_sns_topic" "events" {
  name = "${var.name}-ses-events"
  tags = var.tags
}

resource "aws_sns_topic_policy" "events" {
  arn = aws_sns_topic.events.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSesEvents"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "SNS:Publish"
      Resource  = aws_sns_topic.events.arn
      Condition = {
        StringEquals = { "AWS:SourceAccount" = local.account_id }
        ArnLike      = { "AWS:SourceArn" = local.config_set_arn }
      }
    }]
  })
}

resource "aws_sesv2_configuration_set_event_destination" "events" {
  configuration_set_name = var.configuration_set_name
  event_destination_name = "${var.name}-events"

  event_destination {
    enabled = true
    matching_event_types = [
      "SEND",
      "DELIVERY",
      "BOUNCE",
      "COMPLAINT",
      "REJECT",
      "DELIVERY_DELAY",
      "RENDERING_FAILURE",
    ]
    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.events]
}

resource "aws_sqs_queue" "events_dlq" {
  name                      = "${var.name}-ses-events-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "events" {
  name                       = "${var.name}-ses-events"
  visibility_timeout_seconds = 30 * 6
  message_retention_seconds  = 345600
  # Events can beat the sender's bookkeeping or ingest's Sent copy by a moment;
  # the delay plus retries cover that before anything dead-letters.
  delay_seconds           = 5
  sqs_managed_sse_enabled = true
  tags                    = var.tags

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.events_dlq.arn
    maxReceiveCount     = 8
  })
}

resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowEventsTopic"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.events.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.events.arn } }
    }]
  })
}

resource "aws_sns_topic_subscription" "events" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.events.arn
  raw_message_delivery = true
}

data "archive_file" "ses_events" {
  type        = "zip"
  source_dir  = var.ses_events_source_dir
  output_path = "${path.root}/.build/ses-events.zip"
}

resource "aws_cloudwatch_log_group" "ses_events" {
  name              = "/aws/lambda/${var.name}-ses-events"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_iam_role" "ses_events" {
  name = "${var.name}-ses-events"
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

resource "aws_iam_role_policy" "ses_events" {
  name = "ses-events"
  role = aws_iam_role.ses_events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.ses_events.arn}:*"
      },
      {
        Sid      = "Queue"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
        Resource = aws_sqs_queue.events.arn
      },
      {
        Sid      = "Mail"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = var.mail_table_arn
      },
      {
        Sid      = "Suppression"
        Effect   = "Allow"
        Action   = "dynamodb:PutItem"
        Resource = var.directory_table_arn
        Condition = {
          "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["SUPPRESS#*"] }
        }
      },
      {
        # Whether a mailbox still exists, when its Sent copy is missing.
        Sid       = "MailboxExists"
        Effect    = "Allow"
        Action    = "dynamodb:GetItem"
        Resource  = var.directory_table_arn
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["MBX#*"] } }
      },
    ]
  })
}

resource "aws_lambda_function" "ses_events" {
  function_name    = "${var.name}-ses-events"
  description      = "Applies SES delivery events to sesame Sent copies and the suppression list"
  role             = aws_iam_role.ses_events.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "handler.handler"
  filename         = data.archive_file.ses_events.output_path
  source_code_hash = data.archive_file.ses_events.output_base64sha256
  memory_size      = 256
  timeout          = 30
  tags             = var.tags

  environment {
    variables = {
      MAIL_TABLE      = var.mail_table_name
      DIRECTORY_TABLE = var.directory_table_name
      NODE_OPTIONS    = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.ses_events.name
  }
}

resource "aws_lambda_event_source_mapping" "ses_events" {
  event_source_arn        = aws_sqs_queue.events.arn
  function_name           = aws_lambda_function.ses_events.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}
