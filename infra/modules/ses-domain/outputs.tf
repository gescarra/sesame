output "identity_arn" {
  value = aws_sesv2_email_identity.domain.arn
}

output "configuration_set_name" {
  value = aws_sesv2_configuration_set.this.configuration_set_name
}

output "dns_records" {
  description = "Records to publish for the domain (already created when route53_zone_id is set)."
  value       = values(local.dns_records)
}
