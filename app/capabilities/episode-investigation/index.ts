import type {
  AssignmentDefinition,
  AssignmentPlan,
  CapabilityDefinition,
} from '../../orchestration/ports.js';

/** Domain methods enter through registered templates; the general engine knows no domain fields. */
export function createEpisodeInvestigationCapability(
  methods: AssignmentPlan[] = [],
): CapabilityDefinition {
  return {
    card: {
      id: 'episode-investigation',
      version: 'episode-investigation.v3',
      purpose:
        'Investigate an episode using available reproducible methods and separate unavailable evidence branches.',
      work_products: [
        'Episode investigation',
        'Observation and attribution evidence gaps',
      ],
      required_tools: [],
      roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        'Observation and causal-attribution adapters are not configured.',
      ],
    },
    matches: (request) =>
      /episode|investigat|haze|pm2\.?5/i.test(request.objective),
    assignments: (request) => [
      ...methods,
      {
        key: 'evidence-gaps',
        definition_id: 'episode-investigation.gaps',
        brief: request.objective,
        depends_on: [],
      },
    ],
  };
}
export function createEpisodeInvestigationAssignments(): AssignmentDefinition[] {
  return [
    {
      id: 'episode-investigation.gaps',
      version: 'episode-gaps.v3',
      capability: 'episode-investigation',
      agent: 'WorkerShield',
      tools: [],
      instructions:
        'Report unavailable observation and attribution evidence without implying absence in the world.',
      execute: (services) => {
        const gaps = [
          'No observation adapter is configured; observational coverage remains unresolved.',
          'No independent attribution source is configured; causes of the episode remain unresolved.',
        ];
        const artifact = services.save('episode-investigation.evidence-gaps', {
          status: 'partial',
          gaps,
        });
        return {
          status: 'completed',
          summary: gaps.join(' '),
          support: 'gap',
          uncertainty: gaps,
          outputs: [artifact],
        };
      },
    },
  ];
}
