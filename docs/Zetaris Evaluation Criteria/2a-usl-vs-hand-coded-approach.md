# 2a. Reflect on the USL versus a hand-coded approach

## Answer

For a haze episode investigation, the Environmental USL gives analysts one
place to query the onboarded sources.

| Area | Hand-coded approach | Zetaris USL |
| --- | --- | --- |
| Source access | Build and maintain separate source connections. | Query registered sources through Zetaris. |
| Location matching | Map and join locations for each analysis. | Reuse `location_dim` and `location_code`. |
| Cross-source queries | Fetch and combine records in application code. | Query related USL tables with SQL. |
| Quality checks | Write checks separately for each integration. | Reuse quality queries across common tables. |

This can make it faster to prepare data for an investigation and easier to
reuse the same queries and location mappings.

## How the USL can save time

Without the USL, analysts may need to fetch each source, learn its fields, and
match locations each time. The USL keeps these sources and mappings in shared
tables, so the work can be reused. I expect it to reduce repeated setup and
data preparation, especially for recurring investigations. This is an
estimate, not a measured time saving.

Relevant implementation evidence is the
[Environmental USL schema](../../app/adapters/zetaris/usl/env_usl/usl_schema.sql),
[air-quality query example](../../app/adapters/zetaris/sources/air_quality/sql/aq_query.sql),
[FIRMS query](../../app/adapters/zetaris/sources/nasa_firms/sql/firms_query.sql),
[NASA POWER query](../../app/adapters/zetaris/sources/nasa_power/sql/power_query.sql), and the
[coverage and refresh guide](../../app/adapters/zetaris/usl/env_usl/docs/DATA_COVERAFES.md).
