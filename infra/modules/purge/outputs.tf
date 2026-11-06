output "purge_queue_name" {
  value = aws_sqs_queue.purge.name
}

output "purge_dlq_name" {
  value = aws_sqs_queue.purge_dlq.name
}
