import {
  evaluationDefinitionIds,
  evaluationSpecialistRoles,
} from './manager-evaluation-support.mjs';

const exact = ({ id, version, sha256 }) => ({ id, version, sha256 });
function item(key, definition_id, depends_on = [], input = {}) {
  return {
    key,
    definition_id,
    brief: `Execute ${definition_id} for ${key}.`,
    depends_on,
    input,
  };
}

export function createManagerSandboxRegistry({
  ExecutionRegistry,
  managerAgent,
}) {
  const r = new ExecutionRegistry().registerAgent(managerAgent);
  for (const id of evaluationSpecialistRoles)
    r.registerAgent({
      id,
      version: 'evaluation.v1',
      instructions: 'Use the registered deterministic implementation.',
    });
  r.registerCapability({
    card: {
      id: 'evaluation',
      version: '1',
      purpose:
        'Synthetic runtime evaluation methods. eval.produce retains a finding; eval.fail fails with an exact known unavailable error; eval.reviewed and eval.review exercise independent repair; eval.peer-* exercise clarification; eval.slow permits correction.',
      work_products: ['evaluation.finding'],
      required_tools: [],
      roles: ['HazeOps', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        'Synthetic evaluation outputs; no environmental observations.',
      ],
    },
    matches: () => true,
    assignments: () => [
      item('one', 'eval.produce'),
      item('two', 'eval.produce'),
    ],
    peer_requirements: [
      {
        definitions: ['eval.peer-producer', 'eval.peer-reviewer'],
        purpose: 'evidence-clarification',
      },
    ],
    review_requirements: [
      {
        artifact_kind: 'evaluation.reviewed',
        review_definition_id: 'eval.review',
        producer_definition_ids: ['eval.reviewed'],
      },
    ],
    normalizeReview: (a) =>
      a.kind === 'evaluation.review'
        ? {
            verdict: a.content.verdict,
            artifacts: a.content.reviewed_artifacts,
            limitations: ['Synthetic independent review.'],
          }
        : undefined,
  });
  r.registerCapability({
    card: {
      id: 'eval.unavailable',
      version: '1',
      purpose: 'Remote observation requires unavailable permission.',
      work_products: [],
      required_tools: ['denied.observation'],
      roles: ['HazeOps'],
      readiness: 'specified',
      limitations: ['Missing source grant.'],
    },
    matches: () => false,
    assignments: () => [],
    availability: () => ({
      available: false,
      reasons: ['No authorized observation source is configured.'],
    }),
  });
  for (const id of evaluationDefinitionIds)
    r.registerAssignment({
      id,
      version: '1',
      capability: 'evaluation',
      agent:
        id === 'eval.review' || id === 'eval.peer-reviewer'
          ? 'EvidenceCritic'
          : 'HazeOps',
      tools: [],
      instructions: `Registered ${id}.`,
      async execute(s) {
        if (id === 'eval.fail')
          throw new Error(
            'upstream_unavailable: the authorized upstream has no result; use retained-source instead.',
          );
        if (id === 'eval.slow')
          await new Promise((done) => setTimeout(done, 200));
        if (id === 'eval.review') {
          const producer = s.context.inputs.find(
            (a) => a.kind === 'evaluation.reviewed',
          );
          if (!producer) throw new Error('Missing exact producer revision.');
          const a = s.save('evaluation.review', {
            verdict: producer.content.corrected ? 'supported' : 'rejected',
            reviewed_artifacts: [exact(producer)],
          });
          return {
            status: 'completed',
            summary: producer.content.corrected
              ? 'Corrected finding supported.'
              : 'Objection: corrected must be true.',
            support: producer.content.corrected ? 'supported' : 'gap',
            uncertainty: [],
            outputs: [a],
          };
        }
        if (id.startsWith('eval.peer-')) {
          const peer = s.context.peers.find(
            (p) =>
              p.definition_id !== id &&
              p.definition_id.startsWith('eval.peer-'),
          );
          if (!peer)
            throw new Error('A Manager-granted peer channel is required.');
          const received = s.inbox().find((m) => m.sender === peer.id);
          if (id === 'eval.peer-producer' && !received) {
            s.message(
              peer.id,
              'evidence-clarification',
              'Clarify the exact evidence scope.',
            );
            return {
              status: 'waiting_peer',
              summary: 'Waiting for clarification.',
              support: 'partial',
              uncertainty: [],
              outputs: [],
            };
          }
          if (id === 'eval.peer-reviewer' && !received)
            return {
              status: 'waiting_peer',
              summary: 'Waiting for the producer question.',
              support: 'partial',
              uncertainty: [],
              outputs: [],
            };
          if (id === 'eval.peer-reviewer')
            s.message(
              peer.id,
              'evidence-clarification',
              'This is explicitly synthetic evidence.',
            );
        }
        const a = s.save(
          id === 'eval.reviewed' ? 'evaluation.reviewed' : 'evaluation.finding',
          { finding: 'A retained synthetic finding.', ...s.input },
        );
        return {
          status: 'completed',
          summary: 'A synthetic finding is retained; it is not an observation.',
          support: 'supported',
          uncertainty: [],
          outputs: [a],
        };
      },
    });
  return r;
}
