variable "name" {
  description = "Name prefix for resources."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "kms_key_arn" {
  description = "Optional customer-managed KMS key for the mail bucket. Null uses SSE-S3."
  type        = string
  default     = null
}

variable "raw_retention_days" {
  description = "Days to keep landing copies under raw/ after ingest. Keep it at least as long as the 14 days a dead-lettered job can wait for a redrive."
  type        = number
  default     = 14
}

variable "force_destroy" {
  description = "Allow destroying the bucket with objects in it. Never enable in production."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "point_in_time_recovery" {
  description = "DynamoDB PITR. Off by default to keep idle cost near zero."
  type        = bool
  default     = false
}
