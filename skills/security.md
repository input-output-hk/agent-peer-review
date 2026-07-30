# Security Review

Beyond the default review, check: input validation and injection (SQL, command, path traversal, SSRF); authn/authz correctness and missing checks; secrets in code/logs and insecure storage; unsafe deserialization / XXE; error handling that leaks sensitive detail; risky changes in dependency manifests. Report each finding with a severity (critical/high/medium/low) and a concrete remediation.
