output "mail_bucket_name" {
  value = aws_s3_bucket.mail.bucket
}

output "mail_bucket_arn" {
  value = aws_s3_bucket.mail.arn
}

output "mail_table_name" {
  value = aws_dynamodb_table.mail.name
}

output "mail_table_arn" {
  value = aws_dynamodb_table.mail.arn
}
