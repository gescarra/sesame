output "mail_bucket" {
  value = module.storage.mail_bucket_name
}

output "mail_table" {
  value = module.storage.mail_table_name
}

output "directory_table" {
  description = "Set SESAME_DIRECTORY_TABLE to this for the CLI."
  value       = module.directory.table_name
}

output "dns_records" {
  description = "Publish these with your DNS provider unless route53_zone_id is set."
  value       = module.ses_domain.dns_records
}

output "ingest_queue_url" {
  value = module.inbound.ingest_queue_url
}

output "ingest_dlq_url" {
  value = module.inbound.ingest_dlq_url
}

output "url" {
  description = "Where users open sesame."
  value       = module.web.url
}

output "site_bucket" {
  value = module.web.site_bucket
}

output "distribution_id" {
  value = module.web.distribution_id
}

output "api_log_group" {
  value = module.web.api_log_group
}

output "cognito_user_pool_id" {
  value = module.auth.user_pool_id
}

output "cognito_domain_url" {
  value = module.auth.domain_url
}

output "send_dlq_url" {
  value = module.outbound.send_dlq_url
}

output "events_dlq_url" {
  value = module.outbound.events_dlq_url
}

output "alarm_topic_arn" {
  value = module.observability.alarm_topic_arn
}

output "cloudfront_domain_name" {
  description = "The distribution's own hostname. With web_domain set, it redirects there."
  value       = module.web.cloudfront_domain_name
}

output "admin_url" {
  description = "The admin console. Members of admin_group can use it."
  value       = module.web.admin_url
}

output "admin_group" {
  description = "Add administrators with: aws cognito-idp admin-add-user-to-group --group-name <this> ..."
  value       = module.auth.admin_group
}


output "eas_server" {
  description = "The server name to type into an iPhone's Exchange account settings."
  value       = module.web.eas_server
}

output "eas_log_group" {
  value = module.web.eas_log_group
}
