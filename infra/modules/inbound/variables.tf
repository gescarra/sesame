variable "name" {
  description = "Name prefix for resources."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "domain" {
  description = "The mail domain. The receipt rule accepts every address at it; ingest decides what to keep."
  type        = string
}

variable "mail_bucket_name" {
  type = string
}

variable "mail_bucket_arn" {
  type = string
}

variable "kms_key_arn" {
  description = "KMS key of the mail bucket, if it uses one."
  type        = string
  default     = null
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

variable "ingest_source_dir" {
  description = "Directory with the bundled ingest Lambda (packages/ingest/dist). Run `pnpm build` first."
  type        = string
}

variable "activate_rule_set" {
  description = "Make this the active SES receipt rule set. Only one can be active per account and region."
  type        = bool
  default     = true
}

variable "require_tls" {
  description = "Reject inbound connections that don't use TLS."
  type        = bool
  default     = false
}

variable "lambda_memory_mb" {
  description = "Ingest memory. Messages up to 40 MB are parsed in memory."
  type        = number
  default     = 1024
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 60
}

variable "max_concurrency" {
  description = "Maximum concurrent ingest invocations (2–1000)."
  type        = number
  default     = 5
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "search_index_body" {
  description = "Index message bodies for search. Body tokens are most of the index writes; false keeps headers and attachment names only."
  type        = bool
  default     = true
}
