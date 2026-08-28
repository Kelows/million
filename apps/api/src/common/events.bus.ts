import { Global, Injectable, Module } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface BusEvent {
  type: 'live_event' | 'opportunity' | 'paper_trade' | 'crawler_run' | 'wallet_analyzed' | 'token_checked' | 'copyability';
  data?: unknown; // event payload — trade toasts carry symbol/pnl through here
}

/** In-process pub/sub: backend happenings -> SSE -> the UI, no polling lag. */
@Injectable()
export class EventsBus {
  readonly stream = new Subject<BusEvent>();
  emit(type: BusEvent['type'], data?: unknown) {
    this.stream.next(data === undefined ? { type } : { type, data });
  }
}

@Global()
@Module({ providers: [EventsBus], exports: [EventsBus] })
export class EventsBusModule {}
