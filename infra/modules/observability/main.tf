# Alarms on the signals that need a person: dead-lettered mail, stuck queues, API errors and SES
# reputation, plus an optional cost budget. All notify one SNS topic.
#
# There are 9 alarms, within CloudWatch's free tier of 10 alarm metrics per account.

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  dead_letter_queues = {
    ingest = { queue = var.ingest_dlq_name, what = "Inbound or internal mail failed delivery 5 times" }
    send   = { queue = var.send_dlq_name, what = "Outgoing mail could not be handed to SES" }
    events = { queue = var.events_dlq_name, what = "SES delivery events could not be recorded" }
    purge  = { queue = var.purge_dlq_name, what = "A deleted mailbox's mail could not be purged" }
  }
  queues = {
    ingest = var.ingest_queue_name
    send   = var.send_queue_name
  }
  runbook = "See docs/operations.md."
}

# --- Notifications ---

# Not encrypted: CloudWatch and Budgets can only publish to SSE topics that use a customer-managed key,
# and alarm notifications carry no mail content.
resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
  tags = var.tags
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"] }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.alarms.arn
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alarm_emails)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- Mail pipelines ---

resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  for_each = local.dead_letter_queues

  alarm_name          = "${var.name}-${each.key}-dead-letters"
  alarm_description   = "${each.value.what}; the messages wait in ${each.value.queue}. ${local.runbook}"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value.queue }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = local.queues

  alarm_name          = "${var.name}-${each.key}-queue-stuck"
  alarm_description   = "A message has waited over ${var.max_queue_age_seconds / 60} minutes in ${each.value}, so its consumer is failing or not running. ${local.runbook}"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.max_queue_age_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

# --- API ---

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name        = "${var.name}-api-errors"
  alarm_description = "The API returned ${var.api_5xx_threshold} or more server errors in 5 minutes. ${local.runbook}"
  namespace         = "AWS/Lambda/Web"
  metric_name       = "HTTPResponseStatusClass5XX"
  dimensions = {
    FunctionName = var.api_function_name
    EndpointName = var.api_endpoint_name
  }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.api_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

# --- SES reputation (account-wide) ---

resource "aws_cloudwatch_metric_alarm" "ses_reputation" {
  for_each = var.ses_reputation_alarms ? {
    bounce-rate    = { metric = "Reputation.BounceRate", threshold = var.ses_bounce_rate_threshold }
    complaint-rate = { metric = "Reputation.ComplaintRate", threshold = var.ses_complaint_rate_threshold }
  } : {}

  alarm_name          = "${var.name}-ses-${each.key}"
  alarm_description   = "The account's SES ${replace(each.key, "-", " ")} is near the level where SES reviews or pauses sending. ${local.runbook}"
  namespace           = "AWS/SES"
  metric_name         = each.value.metric
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = var.tags
}

# --- Cost ---

resource "aws_budgets_budget" "monthly" {
  count = var.monthly_budget_usd == null ? 0 : 1

  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alarms.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alarms.arn]
  }

  depends_on = [aws_sns_topic_policy.alarms]
}
