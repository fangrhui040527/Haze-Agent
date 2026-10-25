import type {
  AssignmentDefinition,
  CapabilityDefinition,
} from '../../orchestration/ports.js';

export function createEvidenceSynthesisCapability(): CapabilityDefinition {
  return {
    card: {
      id: 'evidence-synthesis',
      version: 'evidence-synthesis.v3',
      purpose:
        'Explain or summarize supplied source material for an arbitrary objective.',
      work_products: [
        'Source-backed synthesis notes',
        'Citation integrity review',
      ],
      required_tools: [],
      roles: ['HazeOps', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        'Supplied attribution does not prove source authenticity.',
        'Citation integrity does not mechanically prove every prose claim.',
      ],
    },
    matches: () => true,
    assignments: (request) => [
      {
        key: 'synthesis',
        definition_id: 'evidence-synthesis.extract',
        brief: request.objective,
        depends_on: [],
      },
      {
        key: 'review',
        definition_id: 'evidence-synthesis.review',
        brief:
          'Independently check exact citations and source support boundaries.',
        depends_on: ['synthesis'],
      },
    ],
  };
}
export function createEvidenceSynthesisAssignments(): AssignmentDefinition[] {
  return [
    {
      id: 'evidence-synthesis.extract',
      version: 'evidence-extract.v3',
      capability: 'evidence-synthesis',
      agent: 'HazeOps',
      tools: [],
      instructions:
        'Read the supplied source references and save bounded notes with precise source quotations. Ask for sources if none exist.',
      execute: (services) => {
        const sources = services.context.inputs.filter(
          (artifact) => artifact.producer.kind !== 'assignment',
        );
        if (!sources.length) {
          services.question(
            'Please import the source material to explain, or clarify which available evidence should support this objective.',
          );
          return {
            status: 'waiting_human',
            summary: 'Waiting for source material.',
            support: 'gap',
            uncertainty: ['No source material was supplied.'],
            outputs: [],
          };
        }
        const notes = sources.map((source, index) => ({
          citation: `S${index + 1}`,
          artifact: {
            id: source.id,
            version: source.version,
            sha256: source.sha256,
          },
          excerpt: (typeof source.content === 'string'
            ? source.content
            : JSON.stringify(source.content)
          ).slice(0, 2400),
        }));
        const artifact = services.save('evidence-synthesis.notes', {
          notes,
          limitations: [
            'Excerpts are bounded; the exact full source remains accessible by immutable reference.',
            'Source origin is user-declared attribution.',
          ],
        });
        return {
          status: 'completed',
          summary: notes
            .map((note) => `[${note.citation}] ${note.excerpt}`)
            .join('\n'),
          support: 'supported',
          uncertainty: [
            'Source authenticity has not been independently established.',
          ],
          outputs: [artifact],
        };
      },
    },
    {
      id: 'evidence-synthesis.review',
      version: 'evidence-review.v3',
      capability: 'evidence-synthesis',
      agent: 'EvidenceCritic',
      tools: [],
      instructions:
        'Check exact notes against independently read source content; never approve producer-owned outputs.',
      execute: (services) => {
        const notes = services.context.inputs.find(
          (artifact) => artifact.kind === 'evidence-synthesis.notes',
        );
        if (!notes)
          throw new Error('Missing synthesis notes for independent review.');
        const data = notes.content as {
          notes: {
            artifact: { id: string; sha256: string };
            excerpt: string;
          }[];
        };
        const checked = data.notes.every((note) =>
          services.context.inputs.some(
            (source) =>
              source.id === note.artifact.id &&
              source.sha256 === note.artifact.sha256 &&
              (typeof source.content === 'string'
                ? source.content
                : JSON.stringify(source.content)
              ).startsWith(note.excerpt),
          ),
        );
        if (!checked)
          throw new Error('Source excerpt or immutable citation mismatch.');
        const artifact = services.save('evidence-synthesis.review', {
          status: 'supported',
          checks: [
            'Exact source references',
            'Quotation prefix match',
            'Separate producer and reviewer',
          ],
          limitations: [
            'This checks extracted material, not scientific validity or every final prose statement.',
          ],
        });
        return {
          status: 'completed',
          summary: 'Independent citation and excerpt integrity checks passed.',
          support: 'supported',
          uncertainty: [
            'Scientific validity and full prose entailment remain unverified.',
          ],
          outputs: [artifact],
        };
      },
    },
  ];
}
