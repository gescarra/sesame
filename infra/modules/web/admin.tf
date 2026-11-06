# The admin console: a second Web Function, served by the same distribution at /admin.
# It reuses the API's sign-in and session cookie, and runs with its own role. That role can
# manage the directory, queues and SES status, but can't read mail: it has no access to the
# mail bucket or the mail table.

locals {
  admin_function_name = "${var.name}-admin"
  admin_log_group     = "/aws/lambda/web/${local.admin_function_name}"
  admin_origin_id     = "admin"
  queue_arn_prefix    = "arn:aws:sqs:${local.region}:${local.account_id}:${var.name}"
}

data "archive_file" "admin" {
  type        = "zip"
  source_dir  = var.admin_source_dir
  output_path = "${path.root}/.build/admin.zip"
}

resource "aws_s3_object" "admin" {
  bucket      = aws_s3_bucket.artifacts.id
  key         = "admin/admin.zip"
  source      = data.archive_file.admin.output_path
  source_hash = data.archive_file.admin.output_base64sha256
  depends_on  = [aws_s3_bucket_versioning.artifacts]
}

resource "aws_cloudwatch_log_group" "admin" {
  name              = local.admin_log_group
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "admin_local" {
  name              = "${local.admin_log_group}.local"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_iam_role" "admin" {
  name               = "${var.name}-admin"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "admin" {
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.admin.arn}:*",
      "arn:aws:logs:*:${local.account_id}:log-group:${local.admin_log_group}.local:*",
    ]
  }

  statement {
    sid = "Directory"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [var.directory_table_arn, "${var.directory_table_arn}/index/*"]
  }

  statement {
    sid       = "QueueStatus"
    actions   = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
    resources = ["${local.queue_arn_prefix}-*"]
  }

  # Peeking and redriving read the dead-letter queues; a move task deletes from the DLQ and
  # sends to the queue each message came from.
  statement {
    sid       = "DeadLetters"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:StartMessageMoveTask", "sqs:ListMessageMoveTasks"]
    resources = ["${local.queue_arn_prefix}-*-dlq"]
  }

  # Redrives, and the purge job queued when a mailbox is deleted.
  statement {
    sid       = "RedriveDestinations"
    actions   = ["sqs:SendMessage"]
    resources = [for q in ["ingest", "send", "ses-events", "purge"] : "${local.queue_arn_prefix}-${q}"]
  }

  statement {
    sid       = "Status"
    actions   = ["cloudwatch:DescribeAlarms", "ses:GetAccount"]
    resources = ["*"]
  }

  statement {
    sid       = "DomainStatus"
    actions   = ["ses:GetEmailIdentity"]
    resources = ["arn:aws:ses:${local.region}:${local.account_id}:identity/*"]
  }

  statement {
    sid       = "Config"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.config_param}"]
  }
}

resource "aws_iam_role_policy" "admin" {
  name   = "admin"
  role   = aws_iam_role.admin.id
  policy = data.aws_iam_policy_document.admin.json
}

resource "awscc_lambda_web_function" "admin" {
  function_name = local.admin_function_name
  tags          = length(var.tags) == 0 ? null : [for k, v in var.tags : { key = k, value = v }]
}

resource "awscc_lambda_web_function_revision" "admin" {
  function_name = awscc_lambda_web_function.admin.function_name

  build_config = {
    code_config = {
      s3_object = {
        bucket     = aws_s3_object.admin.bucket
        key        = aws_s3_object.admin.key
        version_id = aws_s3_object.admin.version_id
      }
    }
    runtime_config = {
      runtime = "nodejs24.x"
    }
  }

  service_config = {
    execution_role_arn              = aws_iam_role.admin.arn
    timeout_seconds                 = 30
    max_concurrency_per_environment = 16
    environment_variables = {
      AWS_LAMBDA_NODEJS_ENTRYPOINT = "server.mjs"
      NODE_OPTIONS                 = "--enable-source-maps"
      SESAME_NAME                  = var.name
      ADMIN_GROUP                  = var.admin_group
      DIRECTORY_TABLE              = var.directory_table_name
      SESAME_CONFIG_PARAM          = local.config_param
      # As for the API: a domain change makes a new revision, so the shared config is reread.
      SESAME_DOMAIN = var.domain_name == null ? "" : var.domain_name
    }
    telemetry_config = {
      logging_config = {
        log_group             = aws_cloudwatch_log_group.admin.name
        application_log_level = "INFO"
        system_log_level      = "WARN"
      }
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_iam_role_policy.admin, aws_s3_bucket_policy.artifacts]
}

resource "awscc_lambda_web_function_endpoint" "admin" {
  function_name = awscc_lambda_web_function.admin.function_name
  endpoint_name = "live"
  endpoint_type = "HomeRegion"
  auth_type     = "IamAuth"

  revision_weights = [{
    revision_id = awscc_lambda_web_function_revision.admin.revision_id
    weight      = 100
  }]

  # A handful of administrators never needs more than one environment.
  scaling_config = { max_environments = 2 }
  # Rate limits come in fixed steps (0, 100, 200 … 1000, 2000 … 10000 requests a second).
  throttle_config = { rate_limit = 100 }
}

resource "awscc_lambda_resource_policy" "admin" {
  resource_arn = awscc_lambda_web_function.admin.function_arn
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "lambda:InvokeWebFunctionEndpoint"
      Resource  = awscc_lambda_web_function_endpoint.admin.endpoint_arn
      Condition = { StringEquals = { "aws:SourceArn" = aws_cloudfront_distribution.this.arn } }
    }]
  })
}
