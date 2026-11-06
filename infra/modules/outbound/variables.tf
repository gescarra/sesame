variable "name" {
  description = "Name prefix for resources."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "identity_arn" {
  description = "SES identity the sender sends as."
  type        = string
}

variable "configuration_set_name" {
  description = "SES configuration set used for sending; its events drive delivery status."
  type        = string
}

variable "mail_bucket_arn" {
  type = string
}

variable "kms_key_arn" {
  type    = string
  default = null
}

variable "mail_table_name" {
  type = string
}

variable "mail_table_arn" {
  type = string
}

variable "directory_table_name" {
  type = string
}

variable "directory_table_arn" {
  type = string
}

variable "sender_source_dir" {
  description = "Directory with the built sender (packages/sender/dist)."
  type        = string
}

variable "ses_events_source_dir" {
  description = "Directory with the built ses-events Lambda (packages/ses-events/dist)."
  type        = string
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 60
}

variable "sender_max_concurrency" {
  description = "Concurrent sender invocations (2-1000). Raise it with your SES send rate."
  type        = number
  default     = 2
}

variable "log_retention_days" {
  type    = number
  default = 14
}
