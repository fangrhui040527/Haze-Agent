# Implemented schema inventory - Haze v0.14

Checked: **26 October 2026**. Source baseline: **`2e13f4c`** (working tree clean before this documentation change).

This is the status-separated companion to [the original schema catalog](schema-catalog-v014.md). That catalog audited an older baseline and listed 89 top-level named Zod validators. The current source has newer World Model, damage-input, episode and synthesis contracts; its earlier “not implemented” World Model entries must not be treated as current status.

## Scope and counts

“Implemented” here means the contract exists and has a current code consumer, or is composed into a consumed validator. It does not mean every architecture requirement for that feature is complete. Partially implemented and missing contracts are listed in [Remaining schema work](schema-remaining-work-v014.md). Schemas are mostly Zod objects in TypeScript, rather than standalone JSON files.

| Inventory                                                 |                                                     Count |
| --------------------------------------------------------- | --------------------------------------------------------: |
| Used top-level named `*Schema` validators                 |                                                   **150** |
| Defined-only top-level named `*Schema` validators         |                                                     **5** |
| Total top-level named `*Schema` validators                |                         **155**: 137 exported, 18 private |
| Additional local named validators                         | **2**, both called `messageSchema` in different functions |
| Additional provider-probe validator                       |                                 **1**, named `completion` |
| General-task SQLite tables                                |                       **20**, including `world_task_pins` |
| World Model SQLite tables, including its migration ledger |                                                    **12** |

The named-validator inventory follows the catalog's first-party `app/` scope. Anonymous nested and registered-tool input/output validators are covered by their enclosing contracts and tool definitions, rather than counted again. TypeScript aliases inferred from a validator are not additional schemas. Separate dashboard and upstream definitions are identified in section 4.

## 1. Already implemented

### Named top-level validators

Every named declaration in this subsection has a runtime use or is composed into a used validator. Internal and compatibility validators are labeled explicitly.

#### Task requests, lifecycle, assignments, results and events (17)

Source: [`app/contracts/tasks.ts`](../../../app/contracts/tasks.ts). The shared v3 task contracts used by the backend and browser. Remaining result-field gaps are listed in [the partial-contract list](schema-remaining-work-v014.md#1-partially-implemented-architecture-contracts).

| Schema                                                        | Visibility |
| ------------------------------------------------------------- | ---------- |
| [`taskIdentitySchema`](../../../app/contracts/tasks.ts#L14)   | Exported   |
| [`taskRequestSchema`](../../../app/contracts/tasks.ts#L18)    | Exported   |
| [`taskStatusSchema`](../../../app/contracts/tasks.ts#L26)     | Exported   |
| [`executionModeSchema`](../../../app/contracts/tasks.ts#L36)  | Exported   |
| [`resourceLimitsSchema`](../../../app/contracts/tasks.ts#L37) | Exported   |
| [`usageSchema`](../../../app/contracts/tasks.ts#L47)          | Exported   |
| [`permissionsSchema`](../../../app/contracts/tasks.ts#L53)    | Exported   |
| [`runSchema`](../../../app/contracts/tasks.ts#L57)            | Exported   |
| [`assignmentSchema`](../../../app/contracts/tasks.ts#L70)     | Exported   |
| [`questionSchema`](../../../app/contracts/tasks.ts#L115)      | Exported   |
| [`correctionSchema`](../../../app/contracts/tasks.ts#L127)    | Exported   |
| [`citationSchema`](../../../app/contracts/tasks.ts#L138)      | Exported   |
| [`taskResultSchema`](../../../app/contracts/tasks.ts#L145)    | Exported   |
| [`taskEventSchema`](../../../app/contracts/tasks.ts#L175)     | Exported   |
| [`taskEventPageSchema`](../../../app/contracts/tasks.ts#L189) | Exported   |
| [`taskRecordSchema`](../../../app/contracts/tasks.ts#L194)    | Exported   |
| [`taskAdmissionSchema`](../../../app/contracts/tasks.ts#L219) | Exported   |

#### Manager decisions, plans and review bindings (9)

Source: [`app/contracts/manager.ts`](../../../app/contracts/manager.ts). Manager interpretation, planning, dispatch, inspections and state; exact producer/reviewer artifact bindings.

| Schema                                                                   | Visibility |
| ------------------------------------------------------------------------ | ---------- |
| [`managerInterpretationSchema`](../../../app/contracts/manager.ts#L6)    | Exported   |
| [`managerAssignmentPlanSchema`](../../../app/contracts/manager.ts#L13)   | Exported   |
| [`managerActionSchema`](../../../app/contracts/manager.ts#L21)           | Exported   |
| [`managerDecisionSchema`](../../../app/contracts/manager.ts#L78)         | Exported   |
| [`managerInspectionSchema`](../../../app/contracts/manager.ts#L91)       | Exported   |
| [`managerPlanRevisionSchema`](../../../app/contracts/manager.ts#L99)     | Exported   |
| [`managerDispatchReceiptSchema`](../../../app/contracts/manager.ts#L111) | Exported   |
| [`managerStateSchema`](../../../app/contracts/manager.ts#L121)           | Exported   |
| [`artifactReviewCheckSchema`](../../../app/contracts/manager.ts#L137)    | Exported   |

#### Manager response synthesis (1)

Source: [`app/agents/manager/index.ts`](../../../app/agents/manager/index.ts). Internal response schema registered on the Manager agent.

| Schema                                                        | Visibility |
| ------------------------------------------------------------- | ---------- |
| [`synthesisSchema`](../../../app/agents/manager/index.ts#L13) | Private    |

#### Agent actions and assignment output (3)

Source: [`app/orchestration/contracts.ts`](../../../app/orchestration/contracts.ts). Action dispatch and assignment submissions. `managerPlanSchema` is the compatibility plan protocol; Manager v4 uses `managerDecisionSchema`.

| Schema                                                                 | Visibility |
| ---------------------------------------------------------------------- | ---------- |
| [`assignmentOutputSchema`](../../../app/orchestration/contracts.ts#L3) | Exported   |
| [`agentActionSchema`](../../../app/orchestration/contracts.ts#L10)     | Exported   |
| [`managerPlanSchema`](../../../app/orchestration/contracts.ts#L56)     | Exported   |

#### Task corrections and controls (4)

Source: [`app/contracts/controls.ts`](../../../app/contracts/controls.ts). Expected revisions, task updates, local controls and receipts.

| Schema                                                               | Visibility |
| -------------------------------------------------------------------- | ---------- |
| [`mutationExpectationSchema`](../../../app/contracts/controls.ts#L5) | Exported   |
| [`taskUpdateSchema`](../../../app/contracts/controls.ts#L11)         | Exported   |
| [`taskControlSchema`](../../../app/contracts/controls.ts#L21)        | Exported   |
| [`controlReceiptSchema`](../../../app/contracts/controls.ts#L28)     | Exported   |

#### Artifacts and imports (7)

Source: [`app/contracts/artifacts.ts`](../../../app/contracts/artifacts.ts). Immutable artifact references/content, producer metadata, imports and objective-relative applicability.

| Schema                                                                   | Visibility |
| ------------------------------------------------------------------------ | ---------- |
| [`boundedJsonSchema`](../../../app/contracts/artifacts.ts#L5)            | Exported   |
| [`artifactContentSchema`](../../../app/contracts/artifacts.ts#L21)       | Exported   |
| [`artifactRefSchema`](../../../app/contracts/artifacts.ts#L30)           | Exported   |
| [`producerSchema`](../../../app/contracts/artifacts.ts#L35)              | Exported   |
| [`artifactSchema`](../../../app/contracts/artifacts.ts#L39)              | Exported   |
| [`artifactApplicabilitySchema`](../../../app/contracts/artifacts.ts#L73) | Exported   |
| [`artifactImportSchema`](../../../app/contracts/artifacts.ts#L82)        | Exported   |

#### Capabilities and roles (2)

Source: [`app/contracts/capabilities.ts`](../../../app/contracts/capabilities.ts). Role enumeration and the implemented public capability-card subset.

| Schema                                                               | Visibility |
| -------------------------------------------------------------------- | ---------- |
| [`agentRoleSchema`](../../../app/contracts/capabilities.ts#L4)       | Exported   |
| [`capabilityCardSchema`](../../../app/contracts/capabilities.ts#L11) | Exported   |

#### Shared scalar helpers (2)

Source: [`app/contracts/common.ts`](../../../app/contracts/common.ts). Identifier and timestamp validation. Unused declarations from this file are separated in section 2.

| Schema                                                     | Visibility |
| ---------------------------------------------------------- | ---------- |
| [`identifierSchema`](../../../app/contracts/common.ts#L12) | Exported   |
| [`timestampSchema`](../../../app/contracts/common.ts#L22)  | Exported   |

#### PM2.5 scope and coverage (2)

Source: [`app/capabilities/pm25/contracts.ts`](../../../app/capabilities/pm25/contracts.ts). Bounded location/time scope and coverage for the PM2.5 capability.

| Schema                                                                  | Visibility |
| ----------------------------------------------------------------------- | ---------- |
| [`pm25ScopeSchema`](../../../app/capabilities/pm25/contracts.ts#L4)     | Exported   |
| [`pm25CoverageSchema`](../../../app/capabilities/pm25/contracts.ts#L33) | Exported   |

#### PM2.5 captures and analysis (2)

Source: [`app/capabilities/pm25/methods.ts`](../../../app/capabilities/pm25/methods.ts). Captured data/provenance and descriptive deterministic analysis.

| Schema                                                                 | Visibility |
| ---------------------------------------------------------------------- | ---------- |
| [`captureSchema`](../../../app/capabilities/pm25/methods.ts#L38)       | Exported   |
| [`pm25AnalysisSchema`](../../../app/capabilities/pm25/methods.ts#L236) | Exported   |

#### PM2.5 World Model payloads (2)

Source: [`app/capabilities/pm25/world.ts`](../../../app/capabilities/pm25/world.ts). Internal validators for review material and projected analysis records.

| Schema                                                                    | Visibility |
| ------------------------------------------------------------------------- | ---------- |
| [`reviewContentSchema`](../../../app/capabilities/pm25/world.ts#L24)      | Private    |
| [`analysisProjectionSchema`](../../../app/capabilities/pm25/world.ts#L34) | Private    |

#### Damage accounting calculations and imports (29)

Source: [`app/contracts/damage-account.ts`](../../../app/contracts/damage-account.ts). Imported attributed effects, unit values, deterministic accounts, coverage, scenarios, checks, reviews and revision bridges. These contracts do not implement upstream health or causal estimation.

| Schema                                                                             | Visibility |
| ---------------------------------------------------------------------------------- | ---------- |
| [`damagePeriodSchema`](../../../app/contracts/damage-account.ts#L10)               | Exported   |
| [`damageOriginSchema`](../../../app/contracts/damage-account.ts#L16)               | Exported   |
| [`damageMissingnessSchema`](../../../app/contracts/damage-account.ts#L22)          | Exported   |
| [`damageScopeSchema`](../../../app/contracts/damage-account.ts#L30)                | Exported   |
| [`damageEffectSchema`](../../../app/contracts/damage-account.ts#L52)               | Exported   |
| [`damageUnitValueSchema`](../../../app/contracts/damage-account.ts#L122)           | Exported   |
| [`damageIncidenceEntrySchema`](../../../app/contracts/damage-account.ts#L138)      | Exported   |
| [`damageCoverageEntrySchema`](../../../app/contracts/damage-account.ts#L152)       | Exported   |
| [`damageScenarioSchema`](../../../app/contracts/damage-account.ts#L161)            | Exported   |
| [`damageSourceFireCategorySchema`](../../../app/contracts/damage-account.ts#L191)  | Exported   |
| [`damageImportSchema`](../../../app/contracts/damage-account.ts#L196)              | Exported   |
| [`damageInputManifestEntrySchema`](../../../app/contracts/damage-account.ts#L209)  | Exported   |
| [`damageInputsSchema`](../../../app/contracts/damage-account.ts#L225)              | Exported   |
| [`damagePhysicalSchema`](../../../app/contracts/damage-account.ts#L232)            | Exported   |
| [`damageWelfareLineSchema`](../../../app/contracts/damage-account.ts#L247)         | Exported   |
| [`damageMoneyTotalSchema`](../../../app/contracts/damage-account.ts#L256)          | Exported   |
| [`damageWelfareSchema`](../../../app/contracts/damage-account.ts#L262)             | Exported   |
| [`damageIncidenceSchema`](../../../app/contracts/damage-account.ts#L270)           | Exported   |
| [`damageOmissionSchema`](../../../app/contracts/damage-account.ts#L278)            | Exported   |
| [`damageCoverageSchema`](../../../app/contracts/damage-account.ts#L296)            | Exported   |
| [`damageOverlapSchema`](../../../app/contracts/damage-account.ts#L304)             | Exported   |
| [`damageSourceFireExtensionSchema`](../../../app/contracts/damage-account.ts#L318) | Exported   |
| [`damageMethodsSchema`](../../../app/contracts/damage-account.ts#L323)             | Exported   |
| [`damageScenariosSchema`](../../../app/contracts/damage-account.ts#L337)           | Exported   |
| [`damageComponentKindSchema`](../../../app/contracts/damage-account.ts#L363)       | Exported   |
| [`damageAccountSchema`](../../../app/contracts/damage-account.ts#L375)             | Exported   |
| [`damageCheckSchema`](../../../app/contracts/damage-account.ts#L400)               | Exported   |
| [`damageReviewSchema`](../../../app/contracts/damage-account.ts#L408)              | Exported   |
| [`damageRevisionBridgeSchema`](../../../app/contracts/damage-account.ts#L421)      | Exported   |

#### Damage collection and revision tool selection (4)

Source: [`app/capabilities/damage-appraisal/index.ts`](../../../app/capabilities/damage-appraisal/index.ts). Internal selection contracts used by the registered damage-account workflow.

| Schema                                                                                   | Visibility |
| ---------------------------------------------------------------------------------------- | ---------- |
| [`toolSelectionSchema`](../../../app/capabilities/damage-appraisal/index.ts#L60)         | Private    |
| [`revisionSideSchema`](../../../app/capabilities/damage-appraisal/index.ts#L67)          | Private    |
| [`revisionSelectionSchema`](../../../app/capabilities/damage-appraisal/index.ts#L71)     | Private    |
| [`damageCollectionInputSchema`](../../../app/capabilities/damage-appraisal/index.ts#L75) | Private    |

#### Damage account component intake (9)

Source: [`app/capabilities/damage-account-intake/contracts.ts`](../../../app/capabilities/damage-account-intake/contracts.ts). The separate account/component manifest intake workflow registered alongside calculated damage accounting.

| Schema                                                                                              | Visibility |
| --------------------------------------------------------------------------------------------------- | ---------- |
| [`damageAccountTypeSchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L9)        | Exported   |
| [`damageAccountScopeSchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L16)      | Exported   |
| [`damageComponentRefSchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L64)      | Exported   |
| [`damageComponentCategorySchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L70) | Exported   |
| [`damageAccountManifestSchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L77)   | Exported   |
| [`damageAccountComponentSchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L85)  | Exported   |
| [`damageReviewTypeSchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L106)       | Exported   |
| [`damageAccountReviewSchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L111)    | Exported   |
| [`damageAccountLineageSchema`](../../../app/capabilities/damage-account-intake/contracts.ts#L121)   | Exported   |

#### Damage inputs retrieved from World Model (5)

Source: [`app/contracts/damage-world.ts`](../../../app/contracts/damage-world.ts). Scoped discovery, exact selection receipts, links, queries and resolution of retained accounting inputs.

| Schema                                                                      | Visibility |
| --------------------------------------------------------------------------- | ---------- |
| [`damageWorldScopeQuerySchema`](../../../app/contracts/damage-world.ts#L14) | Exported   |
| [`damageWorldSelectionSchema`](../../../app/contracts/damage-world.ts#L22)  | Exported   |
| [`damageWorldLinkSchema`](../../../app/contracts/damage-world.ts#L33)       | Exported   |
| [`damageWorldQuerySchema`](../../../app/contracts/damage-world.ts#L37)      | Exported   |
| [`damageWorldResolutionSchema`](../../../app/contracts/damage-world.ts#L51) | Exported   |

#### Episode investigation (5)

Source: [`app/capabilities/episode-investigation/contracts.ts`](../../../app/capabilities/episode-investigation/contracts.ts). Episode scope, context, evidence gaps and independent review. A complete causal episode reconstruction is outside the implemented scope.

| Schema                                                                                            | Visibility |
| ------------------------------------------------------------------------------------------------- | ---------- |
| [`episodeScopeSchema`](../../../app/capabilities/episode-investigation/contracts.ts#L7)           | Exported   |
| [`episodeContextSchema`](../../../app/capabilities/episode-investigation/contracts.ts#L36)        | Exported   |
| [`episodeEvidenceGapSchema`](../../../app/capabilities/episode-investigation/contracts.ts#L44)    | Exported   |
| [`episodeReviewedBranchSchema`](../../../app/capabilities/episode-investigation/contracts.ts#L66) | Exported   |
| [`episodeReviewSchema`](../../../app/capabilities/episode-investigation/contracts.ts#L72)         | Exported   |

#### Evidence synthesis (3)

Source: [`app/capabilities/evidence-synthesis/contracts.ts`](../../../app/capabilities/evidence-synthesis/contracts.ts). Source-linked notes and exact-artifact review of extracted material.

| Schema                                                                                   | Visibility |
| ---------------------------------------------------------------------------------------- | ---------- |
| [`synthesisNoteSchema`](../../../app/capabilities/evidence-synthesis/contracts.ts#L7)    | Exported   |
| [`synthesisNotesSchema`](../../../app/capabilities/evidence-synthesis/contracts.ts#L13)  | Exported   |
| [`synthesisReviewSchema`](../../../app/capabilities/evidence-synthesis/contracts.ts#L19) | Exported   |

#### World Model domain state (16)

Source: [`app/contracts/world.ts`](../../../app/contracts/world.ts). Events, records, relationships, support revisions, assessments, acceptance outcomes, holds, lineage/history pages and operation receipts. The first four schemas and page helper are internal building blocks.

| Schema                                                                 | Visibility |
| ---------------------------------------------------------------------- | ---------- |
| [`worldModeSchema`](../../../app/contracts/world.ts#L12)               | Private    |
| [`worldScopeSchema`](../../../app/contracts/world.ts#L13)              | Private    |
| [`worldRecordRefSchema`](../../../app/contracts/world.ts#L18)          | Private    |
| [`actorSchema`](../../../app/contracts/world.ts#L23)                   | Private    |
| [`worldEventSchema`](../../../app/contracts/world.ts#L28)              | Exported   |
| [`worldRecordSchema`](../../../app/contracts/world.ts#L71)             | Exported   |
| [`worldRelationshipSchema`](../../../app/contracts/world.ts#L84)       | Exported   |
| [`worldSupportRevisionSchema`](../../../app/contracts/world.ts#L95)    | Exported   |
| [`worldAssessmentSchema`](../../../app/contracts/world.ts#L123)        | Exported   |
| [`worldAcceptanceOutcomeSchema`](../../../app/contracts/world.ts#L159) | Exported   |
| [`worldHoldSchema`](../../../app/contracts/world.ts#L187)              | Exported   |
| [`worldLineageEntrySchema`](../../../app/contracts/world.ts#L223)      | Exported   |
| [`pageSchema`](../../../app/contracts/world.ts#L236)                   | Private    |
| [`worldHistoryPageSchema`](../../../app/contracts/world.ts#L242)       | Exported   |
| [`worldLineagePageSchema`](../../../app/contracts/world.ts#L268)       | Exported   |
| [`worldOperationReceiptSchema`](../../../app/contracts/world.ts#L294)  | Exported   |

#### World Model agent services and pinned context (8)

Source: [`app/contracts/world-services.ts`](../../../app/contracts/world-services.ts). Lookup/context/lineage tool contracts and immutable context snapshots.

| Schema                                                                         | Visibility |
| ------------------------------------------------------------------------------ | ---------- |
| [`worldLookupInputSchema`](../../../app/contracts/world-services.ts#L16)       | Exported   |
| [`worldLookupOutputSchema`](../../../app/contracts/world-services.ts#L22)      | Exported   |
| [`worldContextInputSchema`](../../../app/contracts/world-services.ts#L35)      | Exported   |
| [`worldContextOutputSchema`](../../../app/contracts/world-services.ts#L39)     | Exported   |
| [`worldContextToolOutputSchema`](../../../app/contracts/world-services.ts#L55) | Exported   |
| [`worldContextSnapshotSchema`](../../../app/contracts/world-services.ts#L58)   | Exported   |
| [`worldLineageInputSchema`](../../../app/contracts/world-services.ts#L76)      | Exported   |
| [`worldLineageOutputSchema`](../../../app/contracts/world-services.ts#L88)     | Exported   |

#### World Model HTTP API and control plane (16)

Source: [`app/contracts/world-api.ts`](../../../app/contracts/world-api.ts). Browse, paging, record detail/current status, task relationships, history/lineage, projection rebuild and API error contracts.

| Schema                                                                            | Visibility |
| --------------------------------------------------------------------------------- | ---------- |
| [`recordIdSchema`](../../../app/contracts/world-api.ts#L11)                       | Private    |
| [`cursorSchema`](../../../app/contracts/world-api.ts#L12)                         | Private    |
| [`worldApiPageQuerySchema`](../../../app/contracts/world-api.ts#L20)              | Exported   |
| [`worldApiBrowseQuerySchema`](../../../app/contracts/world-api.ts#L25)            | Exported   |
| [`worldBrowseResponseSchema`](../../../app/contracts/world-api.ts#L32)            | Exported   |
| [`worldProjectionRebuildRequestSchema`](../../../app/contracts/world-api.ts#L71)  | Exported   |
| [`worldProjectionRebuildResponseSchema`](../../../app/contracts/world-api.ts#L72) | Exported   |
| [`worldApiRecordParamsSchema`](../../../app/contracts/world-api.ts#L79)           | Exported   |
| [`worldCurrentStatusSchema`](../../../app/contracts/world-api.ts#L83)             | Exported   |
| [`worldRecordDetailResponseSchema`](../../../app/contracts/world-api.ts#L89)      | Exported   |
| [`worldTaskResponseSchema`](../../../app/contracts/world-api.ts#L98)              | Exported   |
| [`worldRecordHistoryResponseSchema`](../../../app/contracts/world-api.ts#L114)    | Exported   |
| [`worldRecordLineageResponseSchema`](../../../app/contracts/world-api.ts#L115)    | Exported   |
| [`worldApiRecordReadQuerySchema`](../../../app/contracts/world-api.ts#L117)       | Exported   |
| [`worldRecordReadResponseSchema`](../../../app/contracts/world-api.ts#L121)       | Exported   |
| [`worldApiErrorSchema`](../../../app/contracts/world-api.ts#L136)                 | Exported   |

#### Runtime synthesis (1)

Source: [`app/tasks/runtime.ts`](../../../app/tasks/runtime.ts). Internal final-answer synthesis contract.

| Schema                                                  | Visibility |
| ------------------------------------------------------- | ---------- |
| [`synthesisSchema`](../../../app/tasks/runtime.ts#L149) | Private    |

#### Graph execution metadata (2)

Source: [`app/graph.ts`](../../../app/graph.ts). Supporting graph workflow metadata/version validation; these are not additional domain-authority records.

| Schema                                                 | Visibility |
| ------------------------------------------------------ | ---------- |
| [`executionMetadataSchema`](../../../app/graph.ts#L12) | Private    |
| [`workflowVersionSchema`](../../../app/graph.ts#L19)   | Private    |

#### Compatibility graph metadata (1)

Source: [`app/compatibility/graph.ts`](../../../app/compatibility/graph.ts). Supporting compatibility/checkpoint metadata validation.

| Schema                                                      | Visibility |
| ----------------------------------------------------------- | ---------- |
| [`metadataSchema`](../../../app/compatibility/graph.ts#L22) | Private    |

### Additional local validators

These are real validators declared inside execution functions, separate from the 155 top-level declarations.

| Schema          | Source                                                                                          | Validated payload                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `messageSchema` | [episode-investigation/index.ts](../../../app/capabilities/episode-investigation/index.ts#L201) | `linked_analyses`, optional `context`, and `gap_report`; checked with `safeParse`. |
| `messageSchema` | [evidence-synthesis/index.ts](../../../app/capabilities/evidence-synthesis/index.ts#L187)       | An exact artifact reference; checked with `safeParse`.                             |

### Additional supporting validator

| Validator    | Source                                               | Scope                                                                                                                                           |
| ------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `completion` | [provider.ts](../../../app/adapters/provider.ts#L34) | Provider compatibility probe: nonempty `choices` with assistant-role message/content. This is not the general model-receipt or action contract. |

### World Model implementation status

World Model is **implemented in the current general engine**, including acceptance outcomes, support revisions, holds, current-state checks, history, lineage, transactional persistence and projection rebuilding. See [WorldModelStore.evaluateAcceptance](../../../app/tasks/world-store.ts#L772), [the migration implementation](../../../app/tasks/world-schema.ts#L153), [composition](../../../app/composition.ts#L36), and [the control-plane guide](../../testing/world-model-control-plane.md).

Automatic acceptance is configuration-dependent: an unset policy disables it; `research-v1` enables the supported policy. Its stated-use boundary is exact reviewed research/accounting work products. This implementation does not establish qualified scientific approval or acceptance of final narrative conclusions. The original catalog's missing-World-Model conclusion belongs to its older snapshot.

### Implemented non-Zod contracts

These are additional TypeScript/runtime contracts. Their existence should not be described as a separate JSON Schema file or a second validator for each inferred type.

| Area                               | Implemented contracts                                                                                                  | Source / enforcement                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution registry                 | `AgentDefinition`, `AssignmentDefinition`, `CapabilityDefinition`, `ToolDefinition`                                    | [orchestration/ports.ts](../../../app/orchestration/ports.ts); registered agents, assignments, capabilities and tools; tool definitions carry input/output validators. |
| Manager context                    | `ManagerContext`                                                                                                       | [contracts/manager.ts](../../../app/contracts/manager.ts); context assembly.                                                                                           |
| Work ledgers                       | `AttemptRecord`, `ActionRecord`                                                                                        | [tasks/store.ts](../../../app/tasks/store.ts); SQLite and transition checks.                                                                                           |
| Execution fences                   | `LeaseExpectation`, `ManagerFence`                                                                                     | [tasks/store.ts](../../../app/tasks/store.ts); lease, generation and revision checks.                                                                                  |
| Peer collaboration                 | `PeerChannel`, `PeerMessage`                                                                                           | [tasks/store.ts](../../../app/tasks/store.ts); durable bounded local channels/messages. Full architecture metadata is partial.                                         |
| Model adapter                      | `AgentModelInput`, `AgentModelCompletion`, `AgentModelReceipt`, `AgentModel`                                           | [adapters/agent-model.ts](../../../app/adapters/agent-model.ts); provider HTTP, runtime checks and persisted attempts.                                                 |
| PM2.5 evidence                     | `EvidenceCapture`, `EvidenceRow`                                                                                       | [pm25/evidence.ts](../../../app/capabilities/pm25/evidence.ts); capture/schema validation and deterministic methods.                                                   |
| Capability World Model integration | `CapabilityWorldModelAdapter`, `WorldModelRecordDraft`, `WorldModelReviewRequirement`, `WorldModelAcceptanceCandidate` | [orchestration/ports.ts](../../../app/orchestration/ports.ts); registered capability adapters.                                                                         |
| Task/World Model bridge            | `WorldProjectionRecordInput`, `WorldCapabilityAdapterInput`                                                            | [tasks/store.ts](../../../app/tasks/store.ts); artifact projection, finalization and reuse checks.                                                                     |
| World Model writes                 | `PutWorldRecordInput`, `RelateWorldRecordsInput`, `WorldWriteResult`, `WorldAcceptanceInput`                           | [tasks/world-store.ts](../../../app/tasks/world-store.ts); transactional writes and validators above.                                                                  |
| Acceptance policy                  | `WorldAcceptancePolicy`                                                                                                | [tasks/world-policy.ts](../../../app/tasks/world-policy.ts); server-owned policy resolution.                                                                           |
| Graph checkpoint state             | `Annotation.Root` task/run/generation/objective/assignment/action/artifact references                                  | [orchestration/runtime.ts](../../../app/orchestration/runtime.ts), [checkpoints/sqlite.ts](../../../app/checkpoints/sqlite.ts); persisted reference state.             |
| Idempotent operations              | Scope, key, fingerprint and receipt                                                                                    | [tasks/store.ts](../../../app/tasks/store.ts); operations table, canonical JSON fingerprint and replay/conflict checks.                                                |

### Implemented SQLite storage schemas

Most record bodies are serialized JSON, with application validators/runtime checks enforcing their content. The tables below are storage definitions, not 32 additional Zod validators. Checkpointer-managed internal tables are separate from this application table inventory.

| Owner                                                 | Tables                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Task/run/assignment                                   | `tasks`, `runs`, `assignments`, `assignment_history`                                      |
| Idempotency/events                                    | `operations`, `events`                                                                    |
| Artifacts/applicability                               | `artifacts`, `applicability`                                                              |
| Governed cross-task World Model pins                  | `world_task_pins`                                                                         |
| Human coordination                                    | `corrections`, `questions`                                                                |
| Executed work                                         | `attempts`, `actions`                                                                     |
| Peer collaboration                                    | `channels`, `channel_history`, `messages`                                                 |
| Task checkpoint references                            | `checkpoints`                                                                             |
| Manager coordination                                  | `manager_state`, `manager_state_history`, `manager_decisions`                             |
| World Model canonical events/entities/relationships   | `world_events`, `world_entities`, `world_relationships`                                   |
| World Model assessments/acceptance/dependencies/holds | `world_assessments`, `world_acceptances`, `world_dependencies`, `world_holds`             |
| World Model idempotent receipts                       | `world_operation_receipts`                                                                |
| World Model derived projections                       | `world_projection_entities`, `world_projection_relationships`, `world_projection_cursors` |
| World Model migration ledger                          | `world_schema_migrations`                                                                 |

Sources: [TaskStore SQL](../../../app/tasks/store.ts#L332) (20 tables) and [World Model SQL migrations](../../../app/tasks/world-schema.ts#L1) (12 tables). The storage marker `haze.general.sqlite.v1` and World Model migration version are separate contracts.

## 2. Defined in code, but no active consumer found

These five schemas exist, so they are not missing implementations. They are kept separate because declaration alone is not a wired feature. The consumer check covered current first-party application and frontend source, including dynamic-import consumers; type-only references do not count as validation.

| Schema                      | Source                                                                                                     | Defined shape                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `damageComponentRefsSchema` | [`app/capabilities/damage-appraisal/inputs.ts`](../../../app/capabilities/damage-appraisal/inputs.ts#L227) | Record of string keys to exact artifact references.                                                                      |
| `referenceSchema`           | [`app/contracts/common.ts`](../../../app/contracts/common.ts#L17)                                          | Generic reference: `id`, `revision`, `sha256`; current artifact and World Model paths use their own reference contracts. |
| `reasonSchema`              | [`app/contracts/common.ts`](../../../app/contracts/common.ts#L23)                                          | Reason: `code`, `explanation`.                                                                                           |
| `inputOriginSchema`         | [`app/contracts/common.ts`](../../../app/contracts/common.ts#L27)                                          | Origin enum: `synthetic_fixture`, `captured_operating_case`, `live_operating_case`.                                      |
| `worldRecordNotFoundSchema` | [`app/contracts/world-api.ts`](../../../app/contracts/world-api.ts#L143)                                   | World Model not-found error wrapper; not the currently consumed API error validator.                                     |

## 3. Helpers and retired contracts are not missing schemas

- [`promptSchema`](../../../app/tasks/runtime.ts#L96) converts a Zod validator to a JSON Schema representation for model prompting. It is not another validator declaration.
- `hasCompoundSchema` inspects JSON Schema structure; `migrateWorldSchema` performs SQL migration. Their names do not make them data validators.
- Local `nativeSchema` is a boolean and `actionSchema` selects an existing validator; neither is a new validator declaration.
- Scalar helpers such as `text`, `revision`, `amount`, `refs` and `timestamp`, anonymous nested validators and tool validators remain part of their enclosing contracts.
- Historical v2 scheduling schemas and `/run` are retired, not missing v3 work. See [the original catalog's retired-contract appendix](schema-catalog-v014.md#appendix-b-retired-contracts).

## 4. Supporting dashboard and upstream definitions

These exist outside the general-engine named-validator inventory. They do not implement reviewed reusable H-MEM lessons, general task monitoring, upstream scientific methods or effect delivery.

| Area                           | Existing definitions                                                                                                                                                                                                                                         | Boundary                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Dashboard evidence archive     | `haze.evidence.v2-subset`                                                                                                                                                                                                                                    | Retained evidence metadata; pinned/unreviewed dashboard records.                                                   |
| Dashboard World Model          | Location/source/station/evidence entities; PM2.5 modeled/observed/forecast, hotspot and Zetaris facts; near/published_by relationships                                                                                                                       | Separate descriptive/dashboard storage. The active general engine now has its own transactional World Model above. |
| Dashboard H-MEM                | `HmemRecord`, `HmemEngine`, `RecalledExchange`, `ChatMemory`                                                                                                                                                                                                 | Chat-exchange storage/recall, not reviewed scientific lessons.                                                     |
| Dashboard pinned queries       | `PinnedQuery`                                                                                                                                                                                                                                                | TypeScript/query configuration, not a general validated lineage record.                                            |
| Dashboard monitoring           | `WatcherSpec`, `WatcherState`, `WatcherRunReport`, `WatcherView`                                                                                                                                                                                             | Supporting source refresh/watch state, not a general authorized task subscription/notification contract.           |
| Provider probes                | `ProbeProviderSelection`, `ProbeProviderResult` / `ProviderProbeResult`, `ProbeProvider` and `completion`                                                                                                                                                    | Compatibility probing.                                                                                             |
| Pinned reference-engine ports  | `MemoryRecord`, `MemoryAuditEntry`, `MemoryQuery`, `MemoryEngine`, `WorldProvenance`, `WorldEntity`, `EntityInput`, `Observation`, `IngestReport`, `WorldEvent`, `WorldAuditEntry`, `WorldEngine`, `WorldUtilities`, `EngineProvenance`, `HazeEngineOptions` | Supporting adapter/loader/probe contracts; distinct from active `app/contracts/world.ts` records.                  |
| SmokeLedger SQL / mirrored USL | `towns`, `fires`, `wind`, `pm25`, `concessions`, `companies`, `runs`, `trajectory_points`, `attribution`, `projections`, `cases`, `case_events`, `evidence`, `guidance`, `agent_runs`                                                                        | Upstream relational/semantic definitions; presence does not implement application estimation capabilities.         |
| Environment USL                | `location_dim`, `location_code`, `air_quality_obs`, `active_fires`, `power_daily`, `windy_forecast_obs`, `windy_air_quality_obs`, `weather_forecast`                                                                                                         | Upstream semantic definitions.                                                                                     |
| Law USL                        | `law_documents`, `law_pages`                                                                                                                                                                                                                                 | Upstream semantic definitions.                                                                                     |

Supporting-source links and field descriptions remain in [the original catalog](schema-catalog-v014.md#separate-dashboard-and-upstream-schemas-present-but-not-general-engine-authority). Current active composition is [app/composition.ts](../../../app/composition.ts).

## Verification of this inventory

- Used the current code knowledge graph for discovery, declarations, composition and World Model consumers.
- Counted actual TypeScript declarations with the installed TypeScript parser; separated validator objects, local declarations, conversion functions and boolean/helper aliases.
- Checked application/frontend references, including dynamic-import consumers, before separating the five defined-only declarations.
- Checked the SQL table declarations and current World Model runtime/HTTP integration.
- This change is documentation only. No application tests or live provider/source calls were run for this inventory; previous audit test results are not represented as a new test run.
