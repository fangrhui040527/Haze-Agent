import workflowVersions from './workflow_versions.json' with { type: 'json' };

/** Persisted workflow revisions; upgrades require an explicit checkpoint migration. */
export const CHECKPOINT_GRAPH_VERSION = workflowVersions.graph.version;
export const EXECUTION_SCHEMA_VERSION =
  workflowVersions.schemas.executionMetadata.version;
