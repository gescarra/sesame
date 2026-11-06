variable "name" {
  description = "Name prefix for resources."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "point_in_time_recovery" {
  type    = bool
  default = false
}
