# Cognito user pool as a federation broker: users sign in through SAML or OIDC IdPs
# (and optionally as native Cognito users), and the API receives one kind of ID token.

data "aws_region" "current" {}

resource "random_id" "domain_suffix" {
  byte_length = 4
}

resource "aws_cognito_user_pool" "this" {
  name           = var.name
  user_pool_tier = "LITE"

  # Native users sign in with their email. Only admins create them.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 3
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"
  tags                = var.tags
}

# The Lite tier includes the classic hosted UI (version 1); managed login v2 needs Essentials.
resource "aws_cognito_user_pool_domain" "this" {
  domain                = coalesce(var.domain_prefix, "${var.name}-${random_id.domain_suffix.hex}")
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = 1
}

resource "aws_cognito_identity_provider" "this" {
  for_each = { for p in var.identity_providers : p.name => p }

  user_pool_id      = aws_cognito_user_pool.this.id
  provider_name     = each.value.name
  provider_type     = each.value.type
  provider_details  = each.value.details
  attribute_mapping = each.value.attribute_mapping
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.name}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  # The API exchanges codes server-side with PKCE, so no client secret is needed.
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = var.callback_urls
  logout_urls                          = var.logout_urls
  supported_identity_providers = concat(
    var.allow_cognito_users ? ["COGNITO"] : [],
    [for p in aws_cognito_identity_provider.this : p.provider_name],
  )

  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  # The API only reads the ID token at sign-in and keeps its own session.
  id_token_validity      = 60
  access_token_validity  = 60
  refresh_token_validity = 1
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }

  lifecycle {
    precondition {
      condition     = var.allow_cognito_users || length(var.identity_providers) > 0
      error_message = "Configure at least one identity provider or set allow_cognito_users."
    }
  }
}

# Members may use the admin console. Federated users can be added too, once they've signed in once.
resource "aws_cognito_user_group" "admins" {
  name         = "${var.name}-admins"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "sesame administrators: access to the admin console at /admin"
}
