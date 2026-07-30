# Golden / Fixture-Tests

## Zweck

Regressionen an **Core**-Verhalten (Config, Registry, Manifest, Key-Serialisierung)
ohne P01-Kundendaten und ohne OpenAI.

## Layout

```
tests/fixtures/customers/demo/customer.json
tests/golden/README.md
tests/core/*.test.ts
```

## Regeln

- Fixtures sind synthetisch und anonym
- Keine echten Tabellen-/Kundennamen aus Produktivexporten
- Golden-Dateien nur für stabile Core-Outputs (Manifest-Schema, Config-Parse)
- Pipeline-Fachlogik-Goldens später pro Adapter, getrennt von Core
