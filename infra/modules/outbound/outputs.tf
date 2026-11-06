output "send_queue_url" {
  value = aws_sqs_queue.send.id
}

output "send_queue_arn" {
  value = aws_sqs_queue.send.arn
}

output "send_dlq_url" {
  value = aws_sqs_queue.send_dlq.id
}

output "events_dlq_url" {
  value = aws_sqs_queue.events_dlq.id
}

output "sender_function_name" {
  value = aws_lambda_function.sender.function_name
}

output "ses_events_function_name" {
  value = aws_lambda_function.ses_events.function_name
}

output "send_queue_name" {
  value = aws_sqs_queue.send.name
}

output "send_dlq_name" {
  value = aws_sqs_queue.send_dlq.name
}

output "events_dlq_name" {
  value = aws_sqs_queue.events_dlq.name
}
