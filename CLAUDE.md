# PropManage AI — Developer Guide

## Language
English only. No other language in comments, identifiers, strings, commit messages, or documentation.

## Code style
- TypeScript strict mode throughout.
- No comments unless the WHY is non-obvious.
- Conventional commit messages: `feat:`, `fix:`, `chore:`, `docs:`.

## Org scoping
Every query against a business table (tickets, properties, units, tenants, documents, etc.) MUST go through `withOrg()`. No bare `db.select().from(table)` in route handlers.

## Milestones
1. Data layer — schema, migrations, indexes, seed, ticket list/detail UI. ← current
2. Ingestion pipeline
3. RAG query
4. Agent + email
5. Observability + ops view
