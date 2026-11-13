# ActiveSync for phones: a third Web Function, behind the same CloudFront distribution as the
# API at /Microsoft-Server-ActiveSync and /autodiscover. Lambda refuses resource policies that
# make a Web Function public, so the endpoint uses IamAuth like the API's: CloudFront signs each
# request with origin access control and passes the phone's own Basic credentials through,
# which the function checks against app passwords. It runs with its own role and limits, so
# password guessing can't starve the web app.

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

  # Directory: app passwords, devices, memberships, sign-in failure counters, send rate
  # counters, sent ClientIds, and mailbox quota usage when a message is purged. Mail: messages, folder counters, search tokens of purged
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

  # Mail a phone sends, stored once for ingest and the sender to read.
  statement {
    sid       = "OutboundObjects"
    actions   = ["s3:PutObject"]
    resources = ["${var.mail_bucket_arn}/raw/outbound/*"]
  }

  # Internal recipients and the Sent copy go to ingest; external recipients to the sender.
  statement {
    sid       = "Queues"
    actions   = ["sqs:SendMessage"]
    resources = [var.ingest_queue_arn, var.send_queue_arn]
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
    # Longer than CloudFront ever waits (eas_origin_read_timeout, at most 180 s): a held Ping
    # answers before that, and every other command in well under 30 seconds.
    timeout_seconds                 = 300
    max_concurrency_per_environment = 64
    environment_variables = {
      AWS_LAMBDA_NODEJS_ENTRYPOINT = "server.mjs"
      NODE_OPTIONS                 = "--enable-source-maps"
      DIRECTORY_TABLE              = var.directory_table_name
      MAIL_TABLE                   = var.mail_table_name
      MAIL_BUCKET                  = var.mail_bucket_name
      INGEST_QUEUE_URL             = var.ingest_queue_url
      SEND_QUEUE_URL               = var.send_queue_url
      SEND_RATE_LIMIT              = tostring(var.send_rate_limit)
      EAS_PUSH                     = tostring(var.eas_push)
      # Ping must answer before CloudFront gives up on the origin.
      EAS_MAX_HEARTBEAT = tostring(var.eas_origin_read_timeout - 10)
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
  # Only CloudFront can call it; phones sign in to the function itself with app passwords.
  auth_type = "IamAuth"

  revision_weights = [{
    revision_id = awscc_lambda_web_function_revision.eas.revision_id
    weight      = 100
  }]

  scaling_config = { max_environments = var.eas_max_environments }
  # Rate limits come in fixed steps (0, 100, 200 … 1000, 2000 … 10000 requests a second).
  throttle_config = { rate_limit = 100 }
}

# Lets this distribution, and only it, call the endpoint, as for the API.
resource "awscc_lambda_resource_policy" "eas" {
  resource_arn = awscc_lambda_web_function.eas.function_arn
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "lambda:InvokeWebFunctionEndpoint"
      Resource  = awscc_lambda_web_function_endpoint.eas.endpoint_arn
      Condition = { StringEquals = { "aws:SourceArn" = aws_cloudfront_distribution.this.arn } }
    }]
  })
}

# --- CloudFront in front of the endpoint ---------------------------------------------

# Phones send Basic credentials on every request. CloudFront forwards Authorization only when
# it's part of the cache key, so this policy keys on it (and on the query string, which carries
# the command and device). Nothing is cached: the function answers with no-store, and the
# default TTL is 0.
resource "aws_cloudfront_cache_policy" "eas" {
  name        = "${var.name}-eas"
  default_ttl = 0
  min_ttl     = 0
  max_ttl     = 1
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = false
    enable_accept_encoding_brotli = false
    headers_config {
      header_behavior = "whitelist"
      headers { items = ["Authorization"] }
    }
    query_strings_config {
      query_string_behavior = "all"
    }
    cookies_config {
      cookie_behavior = "none"
    }
  }
}

# The ActiveSync headers, and CloudFront-Viewer-Address for per-IP sign-in throttling (the
# start of X-Forwarded-For is whatever the client sent). Never Host: the endpoint answers 404
# for any host but its own.
resource "aws_cloudfront_origin_request_policy" "eas" {
  name = "${var.name}-eas"
  headers_config {
    header_behavior = "whitelist"
    headers {
      items = [
        "Content-Type",
        "User-Agent",
        "MS-ASProtocolVersion",
        "X-MS-PolicyKey",
        "MS-ASAcceptMultiPart",
        "X-Forwarded-Host",
        "CloudFront-Viewer-Address",
      ]
    }
  }
  query_strings_config {
    query_string_behavior = "all"
  }
  cookies_config {
    cookie_behavior = "none"
  }
}

# Autodiscover answers with the host the phone asked; Host itself can't reach the origin.
resource "aws_cloudfront_function" "eas_host" {
  name    = "${var.name}-eas-host"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      request.headers["x-forwarded-host"] = { value: request.headers.host.value };
      return request;
    }
  EOT
}

locals {
  eas_origin_id = "eas"
  # CloudFront path patterns are case-sensitive. iOS uses these spellings; Outlook-style
  # clients capitalise Autodiscover.
  eas_paths = {
    "/Microsoft-Server-ActiveSync*" = false
    "/microsoft-server-activesync*" = false
    "/autodiscover/*"               = true
    "/Autodiscover/*"               = true
  }
}
