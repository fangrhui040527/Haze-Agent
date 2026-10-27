import type { AgentModel } from '../../adapters/agent-model.js';

/** Explicit offline test decisions; production conversation always uses its configured model. */
export function createConversationFixtureModel(): AgentModel {
  return {
    selection: {
      provider: 'fixture',
      model: 'manager-conversation-fixture.v1',
    },
    complete(input) {
      const context = input.context as {
        request: { message: string; history: { role: string; text: string }[] };
        questions: {
          ref: { task_id: string; question_id: string };
          question: string;
        }[];
        retrievals: { unavailable?: string }[];
        evidence: { id: string; kind?: string; observed_at?: string }[];
        available_locations: { id: string; name: string }[];
      };
      const message = context.request.message;
      const reply = (text: string, ids: string[] = []) => ({
        type: 'reply',
        paragraphs: [text],
        citation_ids: ids,
      });
      let decision: unknown;
      if (context.retrievals.some(({ unavailable }) => unavailable)) {
        decision = reply(
          'The requested information is unavailable from the configured source. No current observation was established.',
        );
      } else if (context.evidence.length) {
        const source = context.evidence[0]!;
        decision = reply(
          `This is explicitly synthetic fixture haze information, valid at ${source.observed_at ?? 'the fixture time'}. It establishes no live observation or health advice.`,
          [source.id],
        );
      } else if (/^(hi|hello|hey)[!. ]*$/i.test(message)) {
        decision = reply(
          'Hello! I can explain haze, look up information, or coordinate an investigation.',
        );
      } else if (/what causes haze|why.*haze/i.test(message)) {
        decision = reply(
          'Haze forms when fine particles and gases accumulate in the air. Fires, traffic, industry and dust contribute; dry weather and weak winds can let pollution build up.',
        );
      } else if (/\b(report|investigat\w*|monitor\w*)\b/i.test(message)) {
        decision = {
          type: 'start_task',
          title: message.slice(0, 120),
          objective: message,
        };
      } else if (
        context.questions.length &&
        /^(yes|no|okay|ok|sure|proceed|continue)[.! ]*$/i.test(message)
      ) {
        decision =
          context.questions.length === 1
            ? {
                type: 'answer_task',
                ...context.questions[0]!.ref,
                passage: message,
              }
            : { type: 'clarify', question: 'Which task are you answering?' };
      } else {
        const history = context.request.history
          .slice(-6)
          .map(({ text }) => text)
          .join('\n');
        const location = context.available_locations.find(({ id, name }) =>
          new RegExp(`\\b(?:${id}|${name})\\b`, 'i').test(message),
        );
        if (
          /haze|air quality|pm2.?5|latest/i.test(message) ||
          (location && /haze|location|city/i.test(history))
        )
          decision = {
            type: 'retrieve',
            operation: 'haze_latest',
            fresh: true,
            ...(location ? { location: location.id } : {}),
          };
        else
          decision = reply(
            'I can help explain haze, look up a location, or start a tracked report or investigation.',
          );
      }
      return Promise.resolve(JSON.stringify(decision));
    },
  };
}
