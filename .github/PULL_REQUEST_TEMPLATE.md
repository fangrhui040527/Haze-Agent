## Change

Describe the problem and resulting behavior. Link the relevant issue or architecture decision, if any.

## Verification

List the checks run and their results. Explain any omitted check. Include PostgreSQL integration results when saver behavior or PostgreSQL dependencies change.

## Review checklist

- [ ] The change has one coherent scope and focused verification.
- [ ] Exact dependency and runtime pins, including the lockfile, are updated where needed.
- [ ] No secrets, local databases, checkpoint artifacts, or generated output are included.
- [ ] Any architecture impact is described; LangGraph remains infrastructure for the four Haze roles.
