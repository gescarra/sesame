# ActiveSync for phones: a third Web Function that iPhones call directly, not through
# CloudFront, because a Ping long poll outlasts CloudFront's origin timeout. The endpoint uses
# ApplicationManaged auth: the function checks Basic auth with app passwords itself.
# It runs with its own role and limits, so password guessing can't starve the web app.

locals {
  eas_function_name = "${var.name}-eas"
  eas_log_group     = "/aws/lambda/web/${local.eas_function_name}"
}

data "archive_file" "eas" {
  type        = "zip"
  source_dir  = var.eas_source_dir
  output_path = "${path.root}/.build/eas.zip"
}

resource "aws_s3_object" "eas" {
  bucket      = aws_s3_bucket.artifacts.id
  key         = "eas/eas.zip"
  source      = data.archive_file.eas.output_path
  source_hash = data.archive_file.eas.output_base64sha256
  depends_on  = [aws_s3_bucket_versioning.artifacts]
}

resource "aws_cloudwatch_log_group" "eas" {
  name              = local.eas_log_group
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "eas_local" {
  name              = "${local.eas_log_group}.local"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_iam_role" "eas" {
  name               = "${var.name}-eas"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "eas" {
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.eas.arn}:*",
      "arn:aws:logs:*:${local.account_id}:log-group:${local.eas_log_group}.local:*",
    ]
  }

  # Directory: app passwords, devices, memberships, sign-in failure counters, and mailbox quota
  # usage when a message is purged. Mail: messages, folder counters, search tokens of purged
  # messages, and per-device sync state.
  statement {
    sid = "Tables"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [
      var.directory_table_arn,
      "${var.directory_table_arn}/index/*",
      var.mail_table_arn,
      "${var.mail_table_arn}/index/*",
    ]
  }

  # Message bodies and attachments; deleting is for purging messages from Trash.
  statement {
    sid       = "MailObjects"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${var.mail_bucket_arn}/mbx/*"]
  }

  statement {
    sid       = "ListMailObjects"
    actions   = ["s3:ListBucket"]
    resources = [var.mail_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["mbx/*"]
    }
  }

  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]
    content {
      sid       = "MailKms"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "eas" {
  name   = "eas"
  role   = aws_iam_role.eas.id
  policy = data.aws_iam_policy_document.eas.json
}

resource "awscc_lambda_web_function" "eas" {
  function_name = local.eas_function_name
  tags          = length(var.tags) == 0 ? null : [for k, v in var.tags : { key = k, value = v }]
}

resource "awscc_lambda_web_function_revision" "eas" {
  function_name = awscc_lambda_web_function.eas.function_name

  build_config = {
    code_config = {
      s3_object = {
        bucket     = aws_s3_object.eas.bucket
        key        = aws_s3_object.eas.key
        version_id = aws_s3_object.eas.version_id
      }
    }
    runtime_config = {
      runtime = "nodejs24.x"
    }
  }

  service_config = {
    execution_role_arn = aws_iam_role.eas.arn
    # Ping holds a request open for up to 840 seconds; the rest answer in well under 30.
    timeout_seconds                 = 900
    max_concurrency_per_environment = 64
    environment_variables = {
      AWS_LAMBDA_NODEJS_ENTRYPOINT = "server.mjs"
      NODE_OPTIONS                 = "--enable-source-maps"
      DIRECTORY_TABLE              = var.directory_table_name
      MAIL_TABLE                   = var.mail_table_name
      MAIL_BUCKET                  = var.mail_bucket_name
    }
    telemetry_config = {
      logging_config = {
        log_group             = aws_cloudwatch_log_group.eas.name
        application_log_level = "INFO"
        system_log_level      = "WARN"
      }
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_iam_role_policy.eas, aws_s3_bucket_policy.artifacts]
}

resource "awscc_lambda_web_function_endpoint" "eas" {
  function_name = awscc_lambda_web_function.eas.function_name
  endpoint_name = "live"
  endpoint_type = "HomeRegion"
  # Phones call this endpoint directly; the function signs every request in itself.
  auth_type = "ApplicationManaged"

  revision_weights = [{
    revision_id = awscc_lambda_web_function_revision.eas.revision_id
    weight      = 100
  }]

  scaling_config = { max_environments = var.eas_max_environments }
  # Rate limits come in fixed steps (0, 100, 200 … 1000, 2000 … 10000 requests a second).
  throttle_config = { rate_limit = 100 }
}

# Lets anyone reach the endpoint, as a phone must; the function itself turns away requests
# without a valid app password. To confirm on first deploy: whether ApplicationManaged
# endpoints need this policy at all (function URLs with AuthType NONE do).
resource "awscc_lambda_resource_policy" "eas" {
  resource_arn = awscc_lambda_web_function.eas.function_arn
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowPublicActiveSync"
      Effect    = "Allow"
      Principal = "*"
      Action    = "lambda:InvokeWebFunctionEndpoint"
      Resource  = awscc_lambda_web_function_endpoint.eas.endpoint_arn
    }]
  })
}
