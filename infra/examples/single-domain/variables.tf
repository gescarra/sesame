variable "region" {
  description = "Must support both SES inbound and Lambda Web Functions (us-east-1, us-west-2, eu-west-1)."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for all resources."
  type        = string
  default     = "sesame"
}

variable "domain" {
  description = "The mail domain, e.g. example.com."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for the domain. Null to publish the dns_records output yourself."
  type        = string
  default     = null
}

variable "dmarc_policy" {
  type    = string
  default = "none"
}

variable "dmarc_report_address" {
  type    = string
  default = null
}

variable "activate_rule_set" {
  description = "Make sesame's receipt rule set the active one. Only one can be active per account and region."
  type        = bool
  default     = true
}

variable "force_destroy" {
  description = "Allow tearing down the stack: removes table and user pool deletion protection and lets buckets with mail in them be deleted. For test stacks only."
  type        = bool
  default     = false
}

variable "identity_providers" {
  description = "SAML or OIDC IdPs for sign-in. See modules/auth/variables.tf for the shape."
  type = list(object({
    name              = string
    type              = string
    details           = map(string)
    attribute_mapping = map(string)
  }))
  default = []
}

variable "allow_cognito_users" {
  description = "Allow native Cognito users, created with the AWS CLI or console."
  type        = bool
  default     = false
}

variable "default_identity_provider" {
  description = "Skip the Cognito chooser and send users to this IdP."
  type        = string
  default     = null
}

variable "extra_callback_urls" {
  description = "More OAuth callback URLs, e.g. http://localhost:5173/api/auth/callback for local development."
  type        = list(string)
  default     = []
}

variable "extra_logout_urls" {
  type    = list(string)
  default = []
}

variable "alarm_emails" {
  description = "Addresses that get alarm and budget notifications. Each gets a confirmation email from SNS first."
  type        = list(string)
  default     = []
}

variable "monthly_budget_usd" {
  description = "Notify alarm_emails when the account's monthly cost passes or is forecast to pass this. Null for no budget."
  type        = number
  default     = null
}

variable "web_domain" {
  description = "Hostname for the web app and API, e.g. mail.example.com. With route53_zone_id set, sesame issues its certificate and DNS records. Null to use the CloudFront domain."
  type        = string
  default     = null
}

variable "web_route53_zone_id" {
  description = "Hosted zone for web_domain, when it isn't the mail domain's zone (route53_zone_id)."
  type        = string
  default     = null
}

variable "web_certificate_arn" {
  description = "An existing us-east-1 ACM certificate for web_domain. Set it when web_domain's DNS isn't in route53_zone_id; then point web_domain at the cloudfront_domain_name output yourself."
  type        = string
  default     = null
}

variable "eas_push" {
  description = "Offer push to phones on ActiveSync. Costs about $1.90 a month while any phone uses it; off, phones fetch on their schedule."
  type        = bool
  default     = false
}

variable "eas_origin_read_timeout" {
  description = "Seconds CloudFront waits for ActiveSync; push heartbeats last 10 seconds less. Up to 60, or 180 after a CloudFront quota increase."
  type        = number
  default     = 60
}
