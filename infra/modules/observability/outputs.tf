output "alarm_topic_arn" {
  description = "Subscribe more endpoints (chat webhooks, PagerDuty, SMS) to this topic."
  value       = aws_sns_topic.alarms.arn
}

output "alarm_names" {
  value = concat(
    [for a in aws_cloudwatch_metric_alarm.dead_letters : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.queue_age : a.alarm_name],
    [aws_cloudwatch_metric_alarm.api_errors.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.ses_reputation : a.alarm_name],
  )
}
