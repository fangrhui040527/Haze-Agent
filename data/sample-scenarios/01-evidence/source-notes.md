# Synthetic source notes

These records were written locally for a software demonstration. The district,
values and timestamps do not describe a monitoring site or an actual episode.

The transport-compatible source identifier and raw column names allow the normal
PM2.5 tools to validate and calculate the inputs. They do not imply that Zetaris,
Open-Meteo or another provider returned these values. No SQL or network request
was executed to obtain them.

Values are instantaneous model-style samples in micrograms per cubic metre.
One concentration is null; one expected hourly timestamp is absent. Neither
means zero concentration. The requested UTC interval excludes its end.

Provider issuance, observations, geographical representativeness, fire causation,
health effects and intervention effectiveness are not supplied. The agent must
decide how these gaps limit its answer using its ordinary tools and review loop.
