terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
    }
    awscc = {
      source  = "hashicorp/awscc"
      version = ">= 1.107"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7"
    }
  }

  # Remote state with S3 native locking. Supply bucket/key/region at init:
  #   terraform init -backend-config=backend.hcl
  backend "s3" {
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = { app = "sesame" }
  }
}

# CloudFront certificates must come from us-east-1, whatever the deployment's region.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = { app = "sesame" }
  }
}

# Only for the Lambda Web Function resources, which hashicorp/aws doesn't support yet.
provider "awscc" {
  region = var.region
}
