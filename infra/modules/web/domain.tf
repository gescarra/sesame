# Optional custom domain: an ACM certificate (DNS-validated in Route 53) and alias records
# pointing the name at CloudFront. The SPA and the API share it, since /api/* is on the same
# distribution.

locals {
  manage_certificate = var.domain_name != null && var.certificate_arn == null
  public_url         = var.domain_name == null ? "https://${aws_cloudfront_distribution.this.domain_name}" : "https://${var.domain_name}"
  certificate_arn = (
    var.domain_name == null ? null :
    local.manage_certificate ? aws_acm_certificate_validation.web[0].certificate_arn : var.certificate_arn
  )
}

resource "aws_acm_certificate" "web" {
  count    = local.manage_certificate ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"
  tags              = var.tags

  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = var.route53_zone_id != null
      error_message = "Issuing a certificate for domain_name needs route53_zone_id; otherwise pass certificate_arn."
    }
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = local.manage_certificate ? {
    for o in aws_acm_certificate.web[0].domain_validation_options : o.domain_name => o
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "web" {
  count    = local.manage_certificate ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.web[0].arn
  validation_record_fqdns = [for r in aws_route53_record.certificate_validation : r.fqdn]
}

resource "aws_route53_record" "web" {
  for_each = var.domain_name != null && var.route53_zone_id != null ? toset(["A", "AAAA"]) : toset([])

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
