variable "name" {
  description = "Name prefix for resources."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "api_source_dir" {
  description = "Directory with the built API (packages/api/dist)."
  type        = string
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

variable "kms_key_arn" {
  description = "KMS key encrypting the mail bucket, if any."
  type        = string
  default     = null
}

variable "directory_table_name" {
  type = string
}

variable "directory_table_arn" {
  type = string
}

variable "cognito_domain_url" {
  type = string
}

variable "cognito_user_pool_id" {
  type = string
}

variable "cognito_client_id" {
  type = string
}

variable "cognito_identity_provider" {
  description = "Send users straight to this IdP instead of the Cognito chooser."
  type        = string
  default     = null
}

variable "max_concurrency_per_environment" {
  description = "Concurrent requests per execution environment (1-128)."
  type        = number
  default     = 64
}

variable "max_environments" {
  description = "Cap on concurrent execution environments. Null for the account limit."
  type        = number
  default     = 5
}

variable "rate_limit" {
  description = "Requests per second the endpoint accepts. Null for the account limit."
  type        = number
  default     = 100
}

variable "price_class" {
  type    = string
  default = "PriceClass_100"
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "ingest_queue_url" {
  type = string
}

variable "ingest_queue_arn" {
  type = string
}

variable "send_queue_url" {
  type = string
}

variable "send_queue_arn" {
  type = string
}

variable "send_rate_limit" {
  description = "Messages each person may send per hour, from the web app and phones together."
  type        = number
  default     = 200
}

variable "extra_upload_origins" {
  description = "More origins allowed to upload attachments, e.g. http://localhost:5173 for development."
  type        = list(string)
  default     = []
}

variable "domain_name" {
  description = "Custom hostname for the web app and API, e.g. mail.example.com. Null to use the CloudFront domain."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Hosted zone for domain_name. With it, sesame issues and validates the certificate and points the name at CloudFront."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "An existing us-east-1 ACM certificate covering domain_name, for DNS that isn't in Route 53. Without route53_zone_id, publish the CNAME from the cloudfront_domain_name output yourself."
  type        = string
  default     = null
}

variable "admin_source_dir" {
  description = "Directory with the built admin console (packages/admin/dist)."
  type        = string
}

variable "eas_source_dir" {
  description = "Directory with the built ActiveSync function (packages/eas/dist)."
  type        = string
}

variable "eas_max_environments" {
  description = "Most ActiveSync environments at once. Each holds up to 64 phones' requests."
  type        = number
  default     = 4
}

variable "admin_group" {
  description = "Cognito group whose members may use the admin console."
  type        = string
}

