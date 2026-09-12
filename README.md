# TenderBase

Fresh TenderBase implementation built around the South African National Treasury eTenders OCDS API.

## Architecture

```text
eTenders API
   ↓
30-day paginated collector
   ↓
raw OCDS releases
   ↓
normalized PostgreSQL model
   ↓
TenderBase REST API
   ↓
search / filters / tenders / buyers / suppliers /
awards / contracts / documents / statistics / OCDS
```

The implementation is intentionally independent of previous TenderBase attempts.
