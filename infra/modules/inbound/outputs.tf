output "ingest_queue_url" {
  description = "Internal delivery (M4) enqueues DeliveryJobs here."
  value       = aws_sqs_queue.ingest.id
}

output "ingest_queue_arn" {
  value = aws_sqs_queue.ingest.arn
}

output "ingest_dlq_url" {
  value = aws_sqs_queue.ingest_dlq.id
}

output "ingest_function_name" {
  value = aws_lambda_function.ingest.function_name
}

output "receipt_rule_set_name" {
  value = aws_ses_receipt_rule_set.this.rule_set_name
}

output "ingest_queue_name" {
  value = aws_sqs_queue.ingest.name
}

output "ingest_dlq_name" {
  value = aws_sqs_queue.ingest_dlq.name
}
