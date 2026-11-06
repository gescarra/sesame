variable "name" {
  description = "Name prefix for resources; also the configuration set name."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "domain" {
  description = "The mail domain, e.g. example.com."
  type        = string
}

variable "mail_from_subdomain" {
  description = "Subdomain used as the envelope sender (bounces), so SPF aligns for DMARC."
  type        = string
  default     = "bounce"
}

variable "dmarc_policy" {
  description = "DMARC policy to publish: none, quarantine or reject. Start with none and tighten once reports look clean."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine or reject."
  }
}

variable "dmarc_report_address" {
  description = "Optional address for DMARC aggregate reports (rua)."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Hosted zone to write the DNS records to. Null to manage DNS elsewhere."
  type        = string
  default     = null
}
