# The API as a Lambda Web Function, and one CloudFront distribution in front of it, the SPA and
# the admin console (admin.tf).
# Web Functions are not in hashicorp/aws (checked v6.70.0), so those resources use hashicorp/awscc.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  region        = data.aws_region.current.region
  function_name = "${var.name}-api"
  log_group     = "/aws/lambda/web/${local.function_name}"
  config_param  = "/${var.name}/api/config"
}

# --- Code artifacts ---------------------------------------------------------

resource "aws_s3_bucket" "artifacts" {
  bucket_prefix = "${var.name}-artifacts-"
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Revisions reference a specific object version.
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

# A revision fails for good if its object version is deleted. Endpoints serve the current
# version, so only old noncurrent versions expire.
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-old-builds"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days           = 30
      newer_noncurrent_versions = 5
    }
  }
  depends_on = [aws_s3_bucket_versioning.artifacts]
}

# Lambda fetches revision code as its own service principal, scoped to each function's revisions.
data "aws_iam_policy_document" "artifacts" {
  dynamic "statement" {
    for_each = { api = local.function_name, admin = local.admin_function_name }
    content {
      sid       = "LambdaReads${title(statement.key)}RevisionCode"
      actions   = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = ["${aws_s3_bucket.artifacts.arn}/${statement.key}/*"]
      principals {
        type        = "Service"
        identifiers = ["lambda.amazonaws.com"]
      }
      condition {
        test     = "ArnLike"
        variable = "aws:SourceArn"
        values   = ["arn:aws:lambda:${local.region}:${local.account_id}:web-function/${statement.value}/revision/*"]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket     = aws_s3_bucket.artifacts.id
  policy     = data.aws_iam_policy_document.artifacts.json
  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = var.api_source_dir
  output_path = "${path.root}/.build/api.zip"
  # lambda.mjs is the classic-Lambda fallback entry; the Web Function runs server.mjs.
  excludes = ["lambda.mjs", "lambda.mjs.map"]
}

resource "aws_s3_object" "api" {
  bucket      = aws_s3_bucket.artifacts.id
  key         = "api/api.zip"
  source      = data.archive_file.api.output_path
  source_hash = data.archive_file.api.output_base64sha256
  depends_on  = [aws_s3_bucket_versioning.artifacts]
}

# --- Runtime configuration --------------------------------------------------

resource "random_bytes" "session_key" {
  length = 32
}

# Values that depend on CloudFront and Cognito. The revision only knows the parameter's name,
# which breaks the revision -> endpoint -> distribution -> app client -> config cycle.
# The API reads it once per execution environment.
resource "aws_ssm_parameter" "config" {
  name = local.config_param
  type = "SecureString"
  value = jsonencode({
    publicUrl        = local.public_url
    cognitoDomain    = var.cognito_domain_url
    userPoolId       = var.cognito_user_pool_id
    clientId         = var.cognito_client_id
    identityProvider = var.cognito_identity_provider
    sessionKey       = random_bytes.session_key.base64
  })
  tags = var.tags
}

# --- Execution role ---------------------------------------------------------

resource "aws_cloudwatch_log_group" "api" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# Lambda writes in-Region logs here, then centralizes them into the group above.
resource "aws_cloudwatch_log_group" "api_local" {
  name              = "${local.log_group}.local"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "api" {
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.api.arn}:*",
      "arn:aws:logs:*:${local.account_id}:log-group:${local.log_group}.local:*",
    ]
  }

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
      var.mail_table_arn,
      "${var.mail_table_arn}/index/*",
      var.directory_table_arn,
      "${var.directory_table_arn}/index/*",
    ]
  }

  statement {
    sid       = "MailObjects"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${var.mail_bucket_arn}/mbx/*"]
  }

  statement {
    sid       = "StageAndStoreOutbound"
    actions   = ["s3:PutObject"]
    resources = ["${var.mail_bucket_arn}/staging/*", "${var.mail_bucket_arn}/raw/outbound/*"]
  }

  statement {
    sid       = "ReadUploads"
    actions   = ["s3:GetObject"]
    resources = ["${var.mail_bucket_arn}/staging/*"]
  }

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

  statement {
    sid       = "Config"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.config_param}"]
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

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# --- Web Function -----------------------------------------------------------

resource "awscc_lambda_web_function" "api" {
  function_name = local.function_name
  tags          = length(var.tags) == 0 ? null : [for k, v in var.tags : { key = k, value = v }]
}

resource "awscc_lambda_web_function_revision" "api" {
  function_name = awscc_lambda_web_function.api.function_name

  build_config = {
    code_config = {
      s3_object = {
        bucket     = aws_s3_object.api.bucket
        key        = aws_s3_object.api.key
        version_id = aws_s3_object.api.version_id
      }
    }
    runtime_config = {
      runtime = "nodejs24.x"
    }
  }

  service_config = {
    execution_role_arn              = aws_iam_role.api.arn
    timeout_seconds                 = 30
    max_concurrency_per_environment = var.max_concurrency_per_environment
    environment_variables = {
      AWS_LAMBDA_NODEJS_ENTRYPOINT = "server.mjs"
      NODE_OPTIONS                 = "--enable-source-maps"
      MAIL_TABLE                   = var.mail_table_name
      MAIL_BUCKET                  = var.mail_bucket_name
      DIRECTORY_TABLE              = var.directory_table_name
      INGEST_QUEUE_URL             = var.ingest_queue_url
      SEND_QUEUE_URL               = var.send_queue_url
      SEND_RATE_LIMIT              = tostring(var.send_rate_limit)
      SESAME_CONFIG_PARAM          = local.config_param
      # The API reads publicUrl once per environment. A new revision on a domain change makes
      # every environment pick up the new value.
      SESAME_DOMAIN = var.domain_name == null ? "" : var.domain_name
    }
    telemetry_config = {
      logging_config = {
        log_group             = aws_cloudwatch_log_group.api.name
        application_log_level = "INFO"
        system_log_level      = "WARN"
      }
    }
  }

  # Revisions are immutable: a code or config change creates a new one, the endpoint
  # moves to it, and then the old one is deleted.
  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_iam_role_policy.api, aws_s3_bucket_policy.artifacts]
}

resource "awscc_lambda_web_function_endpoint" "api" {
  function_name = awscc_lambda_web_function.api.function_name
  endpoint_name = "live"
  endpoint_type = "HomeRegion"
  # Only CloudFront, signing through OAC, may call the endpoint.
  auth_type = "IamAuth"

  revision_weights = [{
    revision_id = awscc_lambda_web_function_revision.api.revision_id
    weight      = 100
  }]

  scaling_config  = var.max_environments == null ? null : { max_environments = var.max_environments }
  throttle_config = var.rate_limit == null ? null : { rate_limit = var.rate_limit }
}

resource "awscc_lambda_resource_policy" "api" {
  resource_arn = awscc_lambda_web_function.api.function_arn
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "lambda:InvokeWebFunctionEndpoint"
      Resource  = awscc_lambda_web_function_endpoint.api.endpoint_arn
      Condition = { StringEquals = { "aws:SourceArn" = aws_cloudfront_distribution.this.arn } }
    }]
  })
}

# Attachments upload straight from the browser to S3 with presigned POSTs.
resource "aws_s3_bucket_cors_configuration" "mail" {
  bucket = var.mail_bucket_name
  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = concat([local.public_url], var.extra_upload_origins)
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

# --- SPA bucket ---------------------------------------------------------------

resource "aws_s3_bucket" "site" {
  bucket_prefix = "${var.name}-site-"
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket     = aws_s3_bucket.site.id
  policy     = data.aws_iam_policy_document.site.json
  depends_on = [aws_s3_bucket_public_access_block.site]
}

# --- CloudFront -----------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Web Function origins only support always-amz-auth: CloudFront signs every request and
# leaves the viewer's own Authorization header alone.
resource "aws_cloudfront_origin_access_control" "api" {
  name                              = "${var.name}-api"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always-amz-auth"
  signing_protocol                  = "sigv4"
}

# Client-side routes (no file extension) load the SPA shell. Done here rather than with
# custom error responses, which would also rewrite API 403s and 404s.
resource "aws_cloudfront_function" "spa" {
  name    = "${var.name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code = templatefile("${path.module}/spa.js.tftpl", {
    # Requests to the cloudfront.net name move to the custom domain, where the session cookie lives.
    canonical_host = var.domain_name == null ? "" : var.domain_name
  })
}

locals {
  # AWS managed policies.
  caching_optimized             = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  caching_disabled              = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  all_viewer_except_host_header = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  security_headers_policy       = "67f7725c-6f97-4210-82d7-5512b31e9d03"
  site_origin_id                = "site"
  api_origin_id                 = "api"
}

# Security headers for the SPA. Message bodies render in a srcdoc iframe, which inherits this
# CSP on top of its own stricter one: hence 'unsafe-inline' styles (mail is full of them) and
# https: images (presigned inline parts, and remote images once the user allows them).
resource "aws_cloudfront_response_headers_policy" "site" {
  name    = "${var.name}-site"
  comment = "CSP and security headers for the sesame SPA"

  security_headers_config {
    content_security_policy {
      override = true
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data: https:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ])
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      override                   = true
    }
  }
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = "${var.name} web and API"
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  price_class         = var.price_class
  tags                = var.tags

  origin {
    origin_id                = local.site_origin_id
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id                = local.api_origin_id
    domain_name              = awscc_lambda_web_function_endpoint.api.domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.api.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
  }

  origin {
    origin_id                = local.admin_origin_id
    domain_name              = awscc_lambda_web_function_endpoint.admin.domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.api.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
  }

  default_cache_behavior {
    target_origin_id           = local.site_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = local.caching_disabled
    # Forwards cookies and query strings. The endpoint needs its own Host header.
    origin_request_policy_id   = local.all_viewer_except_host_header
    response_headers_policy_id = local.security_headers_policy
  }

  # The admin console sets its own CSP; the managed policy adds HSTS and the other headers.
  ordered_cache_behavior {
    path_pattern               = "/admin*"
    target_origin_id           = local.admin_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_disabled
    origin_request_policy_id   = local.all_viewer_except_host_header
    response_headers_policy_id = local.security_headers_policy
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  aliases = var.domain_name == null ? [] : [var.domain_name]

  viewer_certificate {
    cloudfront_default_certificate = var.domain_name == null
    acm_certificate_arn            = local.certificate_arn
    ssl_support_method             = var.domain_name == null ? null : "sni-only"
    minimum_protocol_version       = var.domain_name == null ? "TLSv1" : "TLSv1.2_2021"
  }

  lifecycle {
    precondition {
      condition     = var.domain_name == null || var.route53_zone_id != null || var.certificate_arn != null
      error_message = "domain_name needs route53_zone_id (to issue a certificate) or certificate_arn."
    }
  }
}
