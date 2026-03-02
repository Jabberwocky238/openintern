import type { Event } from '../../types/events.js';
import type { MemoryScope } from '../../types/memory.js';
import type { MemoryService } from './memory-service.js';
import type { EventService } from './event-service.js';
import type { ScopeContext } from './scope.js';
import { logger } from '@openintern/utils';

export class EpisodicGenerator {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly eventService: EventService
  ) {}

  async generateFromRun(
    runId: string,
    groupId: string,
    scope: ScopeContext
  ): Promise<void> {
    const memoryScope: MemoryScope = {
      org_id: scope.orgId,
      user_id: scope.userId,
      ...(scope.projectId ? { project_id: scope.projectId } : {}),
      group_id: groupId,
    };

    // Fetch all events for this run
    const events = await this.fetchAllEvents(runId, scope);

    await this.writeDecisions(events, memoryScope);
    await this.writeEvidence(events, memoryScope);
    await this.writeTodos(events, memoryScope);
  }

  private async fetchAllEvents(
    runId: string,
    scope: ScopeContext
  ): Promise<Event[]> {
    const allEvents: Event[] = [];
    let cursor: string | undefined;
    const limit = 100;

    // Paginate through all events
    for (;;) {
      const page = await this.eventService.list(
        runId, scope, cursor, limit
      );
      allEvents.push(...page.events);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }

    return allEvents;
  }

  private async writeDecisions(
    events: Event[],
    scope: MemoryScope
  ): Promise<void> {
    const decisions = events.filter(
      (e) => e.type === 'message.decision'
    );

    for (const event of decisions) {
      if (event.type !== 'message.decision') continue;
      const payload = event.payload as {
        decision: string;
        rationale: string;
        next_actions: string[];
        evidence_refs: Array<{ type: string; id: string }>;
      };

      const text = [
        `DECISION: ${payload.decision}`,
        `Rationale: ${payload.rationale}`,
      ].join('\n');

      try {
        await this.memoryService.memory_write({
          type: 'episodic',
          scope,
          text,
          metadata: {
            episodic_type: 'DECISION',
            run_id: event.run_id,
            agent_id: event.agent_id,
            evidence_refs: payload.evidence_refs,
          },
          importance: 0.8,
        });
      } catch (err) {
        logger.error('Failed to write DECISION episodic memory', {
          runId: event.run_id,
          error: String(err),
        });
      }
    }
  }

  private async writeEvidence(
    events: Event[],
    scope: MemoryScope
  ): Promise<void> {
    const evidenceEvents = events.filter(
      (e) => e.type === 'message.evidence'
    );

    for (const event of evidenceEvents) {
      if (event.type !== 'message.evidence') continue;
      const payload = event.payload as {
        refs: Array<{ type: string; id: string }>;
        summary: string;
      };

      const text = `EVIDENCE: ${payload.summary}`;

      try {
        await this.memoryService.memory_write({
          type: 'episodic',
          scope,
          text,
          metadata: {
            episodic_type: 'EVIDENCE',
            run_id: event.run_id,
            agent_id: event.agent_id,
            refs: payload.refs,
          },
          importance: 0.6,
        });
      } catch (err) {
        logger.error('Failed to write EVIDENCE episodic memory', {
          runId: event.run_id,
          error: String(err),
        });
      }
    }
  }

  private async writeTodos(
    events: Event[],
    scope: MemoryScope
  ): Promise<void> {
    const decisions = events.filter(
      (e) => e.type === 'message.decision'
    );

    for (const event of decisions) {
      if (event.type !== 'message.decision') continue;
      const payload = event.payload as {
        decision: string;
        rationale: string;
        next_actions: string[];
        evidence_refs: Array<{ type: string; id: string }>;
      };

      for (const action of payload.next_actions) {
        if (!action) continue;
        try {
          await this.memoryService.memory_write({
            type: 'episodic',
            scope,
            text: `TODO: ${action}`,
            metadata: {
              episodic_type: 'TODO',
              run_id: event.run_id,
              agent_id: event.agent_id,
              source_decision: payload.decision.slice(0, 200),
            },
            importance: 0.7,
          });
        } catch (err) {
          logger.error('Failed to write TODO episodic memory', {
            runId: event.run_id,
            error: String(err),
          });
        }
      }
    }
  }
}

