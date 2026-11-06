variable "name" {
  description = "Name prefix for resources."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "callback_urls" {
  description = "Allowed OAuth redirect URIs, e.g. https://<distribution>/api/auth/callback."
  type        = list(string)
}

variable "logout_urls" {
  description = "Allowed post-logout redirect URIs."
  type        = list(string)
}

variable "identity_providers" {
  description = <<-EOT
    SAML or OIDC IdPs users sign in with. attribute_mapping maps Cognito attributes to IdP
    claims; it must map "email". Examples:
      { name = "Okta", type = "OIDC", attribute_mapping = { email = "email", name = "name" },
        details = { client_id = "...", client_secret = "...", oidc_issuer = "https://x.okta.com",
                    authorize_scopes = "openid email profile", attributes_request_method = "GET" } }
      { name = "Entra", type = "SAML",
        attribute_mapping = { email = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" },
        details = { MetadataURL = "https://login.microsoftonline.com/.../federationmetadata.xml" } }
  EOT
  type = list(object({
    name              = string
    type              = string
    details           = map(string)
    attribute_mapping = map(string)
  }))
  default = []

  validation {
    condition     = alltrue([for p in var.identity_providers : contains(["SAML", "OIDC"], p.type)])
    error_message = "identity_providers[*].type must be SAML or OIDC."
  }
  validation {
    condition     = alltrue([for p in var.identity_providers : contains(keys(p.attribute_mapping), "email")])
    error_message = "Every identity provider must map the email attribute; mailbox access is keyed by email."
  }
}

variable "allow_cognito_users" {
  description = "Also allow native Cognito users (created by an admin). Useful before an IdP is set up."
  type        = bool
  default     = false
}

variable "domain_prefix" {
  description = "Managed login domain prefix. Defaults to <name>-<random>."
  type        = string
  default     = null
}

variable "deletion_protection" {
  type    = bool
  default = true
}
