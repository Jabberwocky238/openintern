import type { Event } from '@openintern/types/events.js';
import type { ScopeContext } from './scope.js';
import type { IRunRepository } from '@openintern/repository';

export interface EventPage {
  events: Event[];
  next_cursor: string | null;
}

export interface EventListOptions {
  includeTokens?: boolean;
}

export class EventService {
  constructor(private readonly runs: IRunRepository) {}

  async write(event: Event): Promise<number> {
    return this.runs.appendEvent(event);
  }

  async writeBatch(events: Event[]): Promise<number[]> {
    return this.runs.appendEvents(events);
  }

  async list(
    runId: string,
    scope: ScopeContext,
    cursor: string | undefined,
    limit: number,
    options: EventListOptions = {}
  ): Promise<EventPage> {
    const includeTokens = options.includeTokens ?? true;
    const page = await this.runs.getRunEvents(runId, scope, cursor, limit, includeTokens);
    return {
      events: page.items,
      next_cursor: page.nextCursor,
    };
  }
}







