import type { RepositoryMetricsSnapshot } from '../foundation-repository';

export class QueryMeter {
  #batches = 0;
  #statements = 0;
  readonly #operations = new Map<string, number>();

  recordBatch(operation: string, statements: number): void {
    this.#batches += 1;
    this.#statements += statements;
    this.#operations.set(operation, (this.#operations.get(operation) ?? 0) + statements);
  }

  recordStatement(operation: string): void {
    this.#statements += 1;
    this.#operations.set(operation, (this.#operations.get(operation) ?? 0) + 1);
  }

  snapshot(): RepositoryMetricsSnapshot {
    return {
      batches: this.#batches,
      statements: this.#statements,
      operations: Object.freeze(Object.fromEntries(this.#operations)),
    };
  }
}
