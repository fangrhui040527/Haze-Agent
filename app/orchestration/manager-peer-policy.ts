import { z } from 'zod';
import type { ManagerDecision } from '../contracts/manager.js';

type Coordination = Extract<ManagerDecision['action'], { type: 'coordinate' }>;
const participant = z.object({
  assignment_id: z.string(),
  revision: z.number().int().positive(),
});
const peerContextSchema = z.object({
  assignments: z.array(
    z.object({
      id: z.string(),
      revision: z.number().int().positive(),
      definition_id: z.string().optional(),
      status: z.string(),
    }),
  ),
  capabilities: z.array(
    z.object({
      peer_requirements: z
        .array(
          z.object({
            definitions: z.tuple([z.string(), z.string()]),
            purpose: z.string(),
          }),
        )
        .optional(),
    }),
  ),
  peer_grants: z.array(
    z.object({ participants: z.array(participant), purpose: z.string() }),
  ),
});

export function sameCoordination(
  left: Pick<Coordination, 'participants' | 'purpose'>,
  right: {
    participants: { assignment_id: string; revision: number }[];
    purpose: string;
  },
): boolean {
  return (
    left.purpose === right.purpose &&
    left.participants.length === right.participants.length &&
    left.participants.every((item) =>
      right.participants.some(
        (other) =>
          item.assignment_id === other.assignment_id &&
          item.revision === other.revision,
      ),
    )
  );
}

/** Advertises registered prerequisites; it never opens channels or rewrites decisions. */
export function managerPeerPolicy(context: unknown) {
  const parsed = peerContextSchema.safeParse(context);
  if (!parsed.success) return null;
  const { assignments, capabilities, peer_grants: grants } = parsed.data;
  const active = assignments.filter((assignment) =>
    ['queued', 'running'].includes(assignment.status),
  );
  const missing: Coordination[] = [];
  for (const capability of capabilities)
    for (const requirement of capability.peer_requirements ?? []) {
      const [first, second] = requirement.definitions.map((definition) =>
        active.find((assignment) => assignment.definition_id === definition),
      );
      if (!first || !second || first.id === second.id) continue;
      const action: Coordination = {
        type: 'coordinate',
        participants: [
          { assignment_id: first.id, revision: first.revision },
          { assignment_id: second.id, revision: second.revision },
        ],
        purpose: requirement.purpose,
      };
      if (
        !grants.some((grant) => sameCoordination(action, grant)) &&
        !missing.some((other) => sameCoordination(action, other))
      )
        missing.push(action);
    }
  return { missing, grants };
}

export function managerCoordinationIssue(
  context: unknown,
  action: Coordination,
) {
  const policy = managerPeerPolicy(context);
  if (!policy) return null;
  if (policy.grants.some((grant) => sameCoordination(action, grant)))
    return {
      code: 'duplicate_peer_coordination',
      message:
        'This exact participant revision pair and purpose already has a peer grant. Do not reopen or replenish it. Return a complete decision that waits for material progress or inspects admitted work; preserve checkpoint values.',
    };
  if (
    policy.missing.length &&
    !policy.missing.some((choice) => sameCoordination(action, choice))
  )
    return {
      code: 'invalid_peer_coordination',
      message:
        'Return the full decision. A registered peer prerequisite is missing: copy its exact assignment revisions and purpose from peer_prerequisite. Do not substitute another queued assignment or paraphrase the purpose. This hint grants no authority.',
      peer_prerequisite: policy.missing[0],
    };
  return null;
}
