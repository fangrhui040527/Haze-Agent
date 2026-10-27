# Current scenario claim eligibility

The immutable `reduction.review` records the independent check and eligibility at the time that check ran. Its saved `claim_eligibility` field is historical evidence, not an authorization to present that label indefinitely.

Use the store-backed, read-only `reduction.read-claim` tool with the exact selection, assessment and review references to obtain a current label. It rechecks the current task objective/run, exact artifact hashes, current applicability, accessible dependency closure, required tool grants, registered producer/reviewer roles and revisions, and active World Model holds. It then independently reconstructs the original selected decimal comparison again and requires the saved review to match. Stale, inaccessible, held, withdrawn or forged support returns `none` with a bounded reason and no inaccessible content.

The available labels remain `none`, `imported_estimate` and `arithmetic_checked_scenario`. A point estimate can meet or fail the declared target; unavailable comparisons retain their evidence gaps. Synthetic origin stays explicit. All results remain scientifically `unqualified`, and `achieved_reduction` is always false. A current arithmetic check does not establish scientific applicability, digital delivery, World Model acceptance or an achieved effect.
