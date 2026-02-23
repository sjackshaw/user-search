# CI / AWS

This folder contains templates and example IAM policy files used by CI to access AWS resources securely.

Files
- `iam-role-oidc.yml` — CloudFormation template that creates an OIDC provider for GitHub Actions and an IAM role with an inline policy. The template is parameterized; pass `GitHubOrg`, `GitHubRepo`, `GitHubBranch`, `DBSecretArn`, and optionally `RoleName`/`ECRResourceArn` when deploying.
- `iam-policy.json` — example standalone IAM policy (editable) that grants `secretsmanager:GetSecretValue` and ECR permissions. Replace `REGION`, `ACCOUNT_ID`, and secret/repo placeholders before use.
- `role-trust-policy.json` — example trust policy for manual role creation (shows the OIDC principal and subject condition for the repo/branch).

How to deploy (example)

1. Ensure you have the AWS CLI configured with sufficient permissions to create IAM resources.
2. Deploy the CloudFormation template (adjust parameters):

```bash
aws cloudformation deploy \
  --template-file ci/aws/iam-role-oidc.yml \
  --stack-name github-actions-oidc-role \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg=your-org \
    GitHubRepo=your-repo \
    GitHubBranch=main \
    DBSecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:your-secret-name \
    ECRResourceArn=*
```

3. Copy the resulting Role ARN output to the GitHub repository secret `AWS_ROLE_TO_ASSUME` and add `DB_SECRET_ARN` with the Secrets Manager ARN.

Security notes
- Use the least-privilege principle: scope `DBSecretArn` and `ECRResourceArn` to specific ARNs where possible.
- Prefer using GitHub OIDC (the template enables OIDC) so you don't need long-lived AWS credentials in GitHub Secrets.
