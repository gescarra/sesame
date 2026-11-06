output "user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "domain_url" {
  description = "Managed login base URL."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}

output "identity_provider_names" {
  value = [for p in aws_cognito_identity_provider.this : p.provider_name]
}

output "admin_group" {
  value = aws_cognito_user_group.admins.name
}
