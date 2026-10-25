import type { HmemEngine } from '../engines.ts';

/**
 * H-MEM use in Haze: remember each chat exchange and recall similar earlier ones.
 * Recall here is keyword-like (the pinned reference uses a deterministic hash
 * embedder), so it finds overlapping words, not meaning. Sleep and dreaming, which
 * rewrite memories automatically, are never called.
 */

export interface RecalledExchange {
  memoryId: string;
  content: string;
  relevance: number;
  at: string;
}

export class ChatMemory {
  private readonly memory: HmemEngine;

  constructor(memory: HmemEngine) {
    this.memory = memory;
  }

  remember(input: {
    runId: string;
    question: string;
    answerSummary: string;
    locationIds: string[];
    citedItemIds: string[];
  }): string {
    // Only the question goes into the content: H-MEM ranks by overlap with the whole
    // content, and a long answer would drown out the question. The answer summary
    // stays in the label; cited records stay in refs.
    const record = this.memory.add({
      content: `Q: ${input.question}`,
      type: 'general',
      tags: ['haze-chat', ...input.locationIds.map((id) => `location:${id}`)],
      source: 'haze-chat',
      provenance: {
        origin: 'chat_message',
        learnedAt: Date.now(),
        label: `Haze chat run ${input.runId} (template answer): ${input.answerSummary.slice(0, 200)}`,
        refs: input.citedItemIds,
      },
    });
    return record.id;
  }

  recall(question: string, limit = 2): RecalledExchange[] {
    const result = this.memory.query(question, { topN: limit });
    return result.memories.map(({ memory, relevance }) => ({
      memoryId: memory.id,
      content: memory.content,
      relevance,
      at: new Date(memory.timestamp).toISOString(),
    }));
  }

  feedback(memoryId: string, kind: 'helpful' | 'not_helpful' | 'wrong'): void {
    this.memory.feedback(memoryId, kind);
  }
}
