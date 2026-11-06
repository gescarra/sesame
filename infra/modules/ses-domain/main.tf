# SES domain identity (Easy DKIM), custom MAIL FROM, configuration set, and the DNS
# records the domain needs. Records are written to Route 53 when a zone ID is given;
# otherwise publish the `dns_records` output with your DNS provider.

data "aws_region" "current" {}

locals {
  region           = data.aws_region.current.region
  mail_from_domain = "${var.mail_from_subdomain}.${var.domain}"
  dkim_tokens      = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
  dmarc_rua        = var.dmarc_report_address == null ? "" : "; rua=mailto:${var.dmarc_report_address}"

  # Static keys so for_each works before the DKIM tokens are known. Easy DKIM always issues three.
  dns_records = merge(
    {
      inbound_mx = { name = var.domain, type = "MX", value = "10 inbound-smtp.${local.region}.amazonaws.com" }
      mail_from_mx = {
        name  = local.mail_from_domain
        type  = "MX"
        value = "10 feedback-smtp.${local.region}.amazonses.com"
      }
      mail_from_spf = { name = local.mail_from_domain, type = "TXT", value = "v=spf1 include:amazonses.com ~all" }
      dmarc         = { name = "_dmarc.${var.domain}", type = "TXT", value = "v=DMARC1; p=${var.dmarc_policy}${local.dmarc_rua}" }
    },
    {
      for i in range(3) : "dkim_${i}" => {
        name  = "${local.dkim_tokens[i]}._domainkey.${var.domain}"
        type  = "CNAME"
        value = "${local.dkim_tokens[i]}.dkim.amazonses.com"
      }
    },
  )
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = var.name
  tags                   = var.tags

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity         = var.domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  tags                   = var.tags

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "this" {
  for_each = var.route53_zone_id == null ? {} : local.dns_records

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.value]
}
