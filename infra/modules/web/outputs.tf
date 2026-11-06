output "url" {
  description = "Where users open sesame."
  value       = local.public_url
}

output "distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "site_bucket" {
  description = "Upload the built SPA (packages/web/dist) here."
  value       = aws_s3_bucket.site.id
}

output "api_function_name" {
  value = awscc_lambda_web_function.api.function_name
}

output "api_endpoint_domain" {
  value = awscc_lambda_web_function_endpoint.api.domain_name
}

output "api_log_group" {
  value = aws_cloudwatch_log_group.api.name
}

output "api_endpoint_name" {
  value = awscc_lambda_web_function_endpoint.api.endpoint_name
}

output "cloudfront_domain_name" {
  description = "Point domain_name here (CNAME or alias) when its DNS isn't in Route 53."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "admin_url" {
  value = "${local.public_url}/admin"
}

output "admin_log_group" {
  value = aws_cloudwatch_log_group.admin.name
}

