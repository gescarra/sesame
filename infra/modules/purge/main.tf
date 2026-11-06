# Purges a deleted mailbox's mail. Deleting a mailbox (admin console or CLI) removes it from the
# directory and queues a job here; this Lambda deletes its mail-table partition, search tokens and
# objects. Its role can delete mail but not read message content: no s3:GetObject.

resource "aws_sqs_queue" "purge_dlq" {
  name                      = "${var.name}-purge-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "purge" {
  name                       = "${var.name}-purge"
  visibility_timeout_seconds = var.lambda_timeout_seconds * 6
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
  tags                       = var.tags

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.purge_dlq.arn
    maxReceiveCount     = 5
  })
}

data "archive_file" "purge" {
  type        = "zip"
  source_dir  = var.purge_source_dir
  output_path = "${path.root}/.build/purge.zip"
}

resource "aws_cloudwatch_log_group" "purge" {
  name              = "/aws/lambda/${var.name}-purge"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_iam_role" "purge" {
  name = "${var.name}-purge"
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

resource "aws_iam_role_policy" "purge" {
  name = "purge"
  role = aws_iam_role.purge.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.purge.arn}:*"
      },
      {
        Sid      = "Queue"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility", "sqs:SendMessage"]
        Resource = aws_sqs_queue.purge.arn
      },
      {
        Sid      = "DeleteMail"
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:BatchWriteItem"]
        Resource = var.mail_table_arn
      },
      {
        Sid      = "CheckMailboxAndClearMarker"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:DeleteItem"]
        Resource = var.directory_table_arn
        Condition = {
          "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["MBX#*", "PURGE#*"] }
        }
      },
      {
        Sid       = "ListMailObjects"
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = var.mail_bucket_arn
        Condition = { StringLike = { "s3:prefix" = ["mbx/*"] } }
      },
      {
        Sid      = "DeleteMailObjects"
        Effect   = "Allow"
        Action   = "s3:DeleteObject"
        Resource = "${var.mail_bucket_arn}/mbx/*"
      },
    ]
  })
}

resource "aws_lambda_function" "purge" {
  function_name    = "${var.name}-purge"
  description      = "Deletes the stored mail of deleted sesame mailboxes"
  role             = aws_iam_role.purge.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "handler.handler"
  filename         = data.archive_file.purge.output_path
  source_code_hash = data.archive_file.purge.output_base64sha256
  memory_size      = 512
  timeout          = var.lambda_timeout_seconds
  tags             = var.tags

  environment {
    variables = {
      MAIL_TABLE      = var.mail_table_name
      MAIL_BUCKET     = var.mail_bucket_name
      DIRECTORY_TABLE = var.directory_table_name
      PURGE_QUEUE_URL = aws_sqs_queue.purge.id
      NODE_OPTIONS    = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.purge.name
  }
}

resource "aws_lambda_event_source_mapping" "purge" {
  event_source_arn        = aws_sqs_queue.purge.arn
  function_name           = aws_lambda_function.purge.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}
