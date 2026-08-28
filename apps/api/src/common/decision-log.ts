import { Global, Injectable, Module } from '@nestjs/common';

const MAX_LINES = 300;

/**
 * The decision log: every gate verdict the pipeline makes, kept in a ring
 * buffer for the Trading page — the api pane's narration, without the pane.
 */
@Injectable()
export class DecisionLog {
  private readonly lines: { ts: string; line: string }[] = [];

  push(line: string): void {
    console.log(line); // the terminal keeps its narration
    this.lines.push({ ts: new Date().toISOString(), line });
    if (this.lines.length > MAX_LINES) this.lines.shift();
  }

  tail(n = 100): { ts: string; line: string }[] {
    return this.lines.slice(-n).reverse(); // newest first
  }
}

@Global()
@Module({ providers: [DecisionLog], exports: [DecisionLog] })
export class DecisionLogModule {}
