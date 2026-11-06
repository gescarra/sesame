output "table_name" {
  value = aws_dynamodb_table.directory.name
}

output "table_arn" {
  value = aws_dynamodb_table.directory.arn
}
