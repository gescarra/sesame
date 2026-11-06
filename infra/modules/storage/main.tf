# Mail bucket (raw MIME, bodies, attachments, upload staging) and the mail table.

resource "aws_s3_bucket" "mail" {
  bucket_prefix = "${var.name}-mail-"
  force_destroy = var.force_destroy
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "mail" {
  bucket                  = aws_s3_bucket.mail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    # SSE-S3 by default (free); a customer-managed KMS key is opt-in.
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id

  # Compose uploads that were never sent.
  rule {
    id     = "expire-staging"
    status = "Enabled"
    filter {
      prefix = "staging/"
    }
    expiration {
      days = 1
    }
  }

  # Raw MIME is copied into each mailbox's prefix at ingest; the landing copy is short-lived.
  rule {
    id     = "expire-raw"
    status = "Enabled"
    filter {
      prefix = "raw/"
    }
    expiration {
      days = var.raw_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_dynamodb_table" "mail" {
  name                        = "${var.name}-mail"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = var.deletion_protection
  tags                        = var.tags

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }
  attribute {
    name = "gsi3pk"
    type = "S"
  }
  attribute {
    name = "gsi3sk"
    type = "S"
  }

  # Folder view
  global_secondary_index {
    name = "gsi1"
    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
    projection_type = "ALL"
  }

  # Thread view
  global_secondary_index {
    name = "gsi2"
    key_schema {
      attribute_name = "gsi2pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi2sk"
      key_type       = "RANGE"
    }
    projection_type = "KEYS_ONLY"
  }

  # Flagged (sparse)
  global_secondary_index {
    name = "gsi3"
    key_schema {
      attribute_name = "gsi3pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi3sk"
      key_type       = "RANGE"
    }
    projection_type = "KEYS_ONLY"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }
}
