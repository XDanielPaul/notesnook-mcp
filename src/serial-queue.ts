export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // Return the rejection to its caller, but allow the next operation to run.
    this.tail = result.catch(() => {});
    return result;
  }
}
