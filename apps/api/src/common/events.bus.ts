import { Global, Injectable, Module } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface BusEvent {
  type: 'live_event' | 'opportunity' | 'paper_trade' | 'crawler_run';
}

/** In-process pub/sub: backend happenings -> SSE -> the UI, no polling lag. */
@Injectable()
export class EventsBus {
  readonly stream = new Subject<BusEvent>();
  emit(type: BusEvent['type']) {
    this.stream.next({ type });
  }
}

@Global()
@Module({ providers: [EventsBus], exports: [EventsBus] })
export class EventsBusModule {}
