locals {
  repo_root = "${path.root}/../../.."
}

module "storage" {
  source              = "../../modules/storage"
  name                = var.name
  force_destroy       = var.force_destroy
  deletion_protection = !var.force_destroy
}

module "directory" {
  source              = "../../modules/directory"
  name                = var.name
  deletion_protection = !var.force_destroy
}

module "ses_domain" {
  source               = "../../modules/ses-domain"
  name                 = var.name
  domain               = var.domain
  route53_zone_id      = var.route53_zone_id
  dmarc_policy         = var.dmarc_policy
  dmarc_report_address = var.dmarc_report_address
}

module "inbound" {
  source               = "../../modules/inbound"
  name                 = var.name
  domain               = var.domain
  mail_bucket_name     = module.storage.mail_bucket_name
  mail_bucket_arn      = module.storage.mail_bucket_arn
  mail_table_name      = module.storage.mail_table_name
  mail_table_arn       = module.storage.mail_table_arn
  directory_table_name = module.directory.table_name
  directory_table_arn  = module.directory.table_arn
  ingest_source_dir    = "${local.repo_root}/packages/ingest/dist"
  activate_rule_set    = var.activate_rule_set
}

module "auth" {
  source              = "../../modules/auth"
  name                = var.name
  callback_urls       = concat(["${module.web.url}/api/auth/callback"], var.extra_callback_urls)
  logout_urls         = concat(["${module.web.url}/"], var.extra_logout_urls)
  identity_providers  = var.identity_providers
  allow_cognito_users = var.allow_cognito_users
  deletion_protection = !var.force_destroy
}

module "web" {
  source                    = "../../modules/web"
  name                      = var.name
  domain_name               = var.web_domain
  route53_zone_id           = var.web_route53_zone_id != null ? var.web_route53_zone_id : var.route53_zone_id
  certificate_arn           = var.web_certificate_arn
  api_source_dir            = "${local.repo_root}/packages/api/dist"
  admin_source_dir          = "${local.repo_root}/packages/admin/dist"
  eas_source_dir            = "${local.repo_root}/packages/eas/dist"
  admin_group               = module.auth.admin_group
  mail_table_name           = module.storage.mail_table_name
  mail_table_arn            = module.storage.mail_table_arn
  mail_bucket_name          = module.storage.mail_bucket_name
  mail_bucket_arn           = module.storage.mail_bucket_arn
  directory_table_name      = module.directory.table_name
  directory_table_arn       = module.directory.table_arn
  cognito_domain_url        = module.auth.domain_url
  cognito_user_pool_id      = module.auth.user_pool_id
  cognito_client_id         = module.auth.client_id
  cognito_identity_provider = var.default_identity_provider
  ingest_queue_url          = module.inbound.ingest_queue_url
  ingest_queue_arn          = module.inbound.ingest_queue_arn
  send_queue_url            = module.outbound.send_queue_url
  send_queue_arn            = module.outbound.send_queue_arn

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
}

module "outbound" {
  source                 = "../../modules/outbound"
  name                   = var.name
  identity_arn           = module.ses_domain.identity_arn
  configuration_set_name = module.ses_domain.configuration_set_name
  mail_bucket_arn        = module.storage.mail_bucket_arn
  mail_table_name        = module.storage.mail_table_name
  mail_table_arn         = module.storage.mail_table_arn
  directory_table_name   = module.directory.table_name
  directory_table_arn    = module.directory.table_arn
  sender_source_dir      = "${local.repo_root}/packages/sender/dist"
  ses_events_source_dir  = "${local.repo_root}/packages/ses-events/dist"
}

module "purge" {
  source               = "../../modules/purge"
  name                 = var.name
  mail_table_name      = module.storage.mail_table_name
  mail_table_arn       = module.storage.mail_table_arn
  mail_bucket_name     = module.storage.mail_bucket_name
  mail_bucket_arn      = module.storage.mail_bucket_arn
  directory_table_name = module.directory.table_name
  directory_table_arn  = module.directory.table_arn
  purge_source_dir     = "${local.repo_root}/packages/purge/dist"
}

module "observability" {
  source             = "../../modules/observability"
  name               = var.name
  alarm_emails       = var.alarm_emails
  monthly_budget_usd = var.monthly_budget_usd
  ingest_queue_name  = module.inbound.ingest_queue_name
  ingest_dlq_name    = module.inbound.ingest_dlq_name
  send_queue_name    = module.outbound.send_queue_name
  send_dlq_name      = module.outbound.send_dlq_name
  events_dlq_name    = module.outbound.events_dlq_name
  purge_dlq_name     = module.purge.purge_dlq_name
  api_function_name  = module.web.api_function_name
  api_endpoint_name  = module.web.api_endpoint_name
}
