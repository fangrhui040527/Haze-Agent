import { z } from 'zod';
import type {
  AssignmentDefinition,
  CapabilityDefinition,
} from '../../orchestration/ports.js';
import { artifactRefSchema } from '../../contracts/artifacts.js';
import { parseContractJson } from '../../contracts/json.js';
import { synthesisNotesSchema, synthesisReviewSchema } from './contracts.js';
import { evidenceSynthesisWorldModelAdapter } from './world.js';

export function createEvidenceSynthesisCapability(): CapabilityDefinition {
  return {
    prerequisites: [
      {
        definition_id: 'evidence-synthesis.review',
        depends_on_definitions: ['evidence-synthesis.extract'],
      },
    ],
    review_requirements: [
      {
        artifact_kind: 'evidence-synthesis.notes',
        review_definition_id: 'evidence-synthesis.review',
        producer_definition_ids: ['evidence-synthesis.extract'],
      },
    ],
    peer_requirements: [
      {
        definitions: [
          'evidence-synthesis.extract',
          'evidence-synthesis.review',
        ],
        purpose: 'synthesis-review',
      },
    ],
    normalizeReview(artifact) {
      if (artifact.kind !== 'evidence-synthesis.review') return undefined;
      const parsed = synthesisReviewSchema.safeParse(artifact.content);
      return parsed.success
        ? {
            verdict: parsed.data.status,
            artifacts: [parsed.data.notes, ...parsed.data.reviewed_sources],
            limitations: parsed.data.limitations,
          }
        : undefined;
    },
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
    worldModel: evidenceSynthesisWorldModelAdapter,
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
          schema_version: 'haze.evidence-synthesis.notes.v1',
          notes,
          limitations: [
            'Excerpts are bounded; the exact full source remains accessible by immutable reference.',
            'Source origin is user-declared attribution.',
          ],
        });
        const reviewer = services.context.peers.find(
          (peer) => peer.definition_id === 'evidence-synthesis.review',
        );
        if (reviewer)
          services.message(
            reviewer.id,
            'synthesis-review',
            JSON.stringify({
              artifact: {
                id: artifact.id,
                version: artifact.version,
                sha256: artifact.sha256,
              },
            }),
          );
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
        const producer = services.context.peers.find(
          (peer) => peer.definition_id === 'evidence-synthesis.extract',
        );
        const message = services
          .inbox()
          .find((item) => item.sender === producer?.id);
        if (!message)
          return {
            status: 'waiting_peer',
            summary: 'Waiting for exact synthesis notes to review.',
            support: 'partial',
            uncertainty: [],
            outputs: [],
          };
        let payload: unknown;
        try {
          payload = parseContractJson(message.text);
        } catch {
          throw new Error(
            'Synthesis review message is not valid contract JSON.',
          );
        }
        const messageSchema = z.strictObject({
          artifact: artifactRefSchema,
        });
        const parsedMessage = messageSchema.safeParse(payload);
        if (!parsedMessage.success)
          throw new Error(
            'Synthesis review message has an invalid exact reference.',
          );
        const notes = services.read(parsedMessage.data.artifact);
        if (notes.kind !== 'evidence-synthesis.notes')
          throw new Error('Missing synthesis notes for independent review.');
        const parsedNotes = synthesisNotesSchema.safeParse(notes.content);
        if (!parsedNotes.success)
          throw new Error('Synthesis notes do not match the strict schema.');
        const checkedSources = parsedNotes.data.notes.map((note) => {
          const source = services.read(note.artifact);
          const text =
            typeof source.content === 'string'
              ? source.content
              : JSON.stringify(source.content);
          if (
            source.version !== note.artifact.version ||
            source.sha256 !== note.artifact.sha256 ||
            text.slice(0, 2400) !== note.excerpt
          )
            throw new Error('Source excerpt or immutable citation mismatch.');
          return {
            id: source.id,
            version: source.version,
            sha256: source.sha256,
          };
        });
        const reviewContent = synthesisReviewSchema.parse({
          schema_version: 'haze.evidence-synthesis.review.v1',
          notes: parsedMessage.data.artifact,
          reviewed_sources: checkedSources,
          status: 'supported',
          checks: [
            'exact_source_id_version_hash',
            'excerpt_matches_source_prefix',
            'separate_producer_and_reviewer',
          ],
          limitations: [
            'This checks exact citations and excerpts, not source authenticity, scientific validity, or final-prose entailment.',
          ],
        });
        const artifact = services.save(
          'evidence-synthesis.review',
          reviewContent,
        );
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
