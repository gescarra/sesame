variable "name" {
  description = "Name prefix for resources."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "alarm_emails" {
  description = "Addresses that get alarm and budget notifications. Each must confirm the SNS subscription."
  type        = list(string)
  default     = []
}

variable "ingest_queue_name" {
  type = string
}

variable "ingest_dlq_name" {
  type = string
}

variable "send_queue_name" {
  type = string
}

variable "send_dlq_name" {
  type = string
}

variable "events_dlq_name" {
  type = string
}

variable "purge_dlq_name" {
  type = string
}

variable "api_function_name" {
  type = string
}

variable "api_endpoint_name" {
  type = string
}

variable "max_queue_age_seconds" {
  description = "Alarm when a message has waited this long in the ingest or send queue. Ingest retries a failing message for about 30 minutes."
  type        = number
  default     = 1800
}

variable "api_5xx_threshold" {
  description = "Alarm when the API returns this many 5xx responses within 5 minutes."
  type        = number
  default     = 5
}

variable "ses_reputation_alarms" {
  description = "Alarm on the account's SES bounce and complaint rates. These metrics cover every sender in the account and region, not just sesame."
  type        = bool
  default     = true
}

variable "ses_bounce_rate_threshold" {
  description = "SES puts accounts under review at 5% and may pause sending at 10%."
  type        = number
  default     = 0.04
}

variable "ses_complaint_rate_threshold" {
  description = "SES puts accounts under review at 0.1% and may pause sending at 0.5%."
  type        = number
  default     = 0.0008
}

variable "monthly_budget_usd" {
  description = "Notify when the account's actual or forecast monthly cost passes this amount. Null for no budget."
  type        = number
  default     = null
}
