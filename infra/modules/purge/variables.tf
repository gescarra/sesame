variable "name" {
  description = "Name prefix for resources."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "mail_table_name" {
  type = string
}

variable "mail_table_arn" {
  type = string
}

variable "mail_bucket_name" {
  type = string
}

variable "mail_bucket_arn" {
  type = string
}

variable "directory_table_name" {
  type = string
}

variable "directory_table_arn" {
  type = string
}

variable "purge_source_dir" {
  description = "Directory with the built purge Lambda (packages/purge/dist)."
  type        = string
}

variable "lambda_timeout_seconds" {
  description = "A purge that runs out of time continues in a new invocation."
  type        = number
  default     = 300
}

variable "log_retention_days" {
  type    = number
  default = 14
}
