# Repository instructions

Read [README.md](README.md), config/ladders.json and the relevant original handler. Config/source are authoritative for available models and budgets, not a copied model table. Preserve canonical ladder names, pricing/fallback ceilings, timeout budgets, key isolation and usage logging. Tests use synthetic credentials/provider mocks; model-quality evidence and deployment acceptance are separate.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
