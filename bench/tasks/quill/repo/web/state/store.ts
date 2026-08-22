/** A tiny observable store. Subscribers are called on every committed change. */
export type Listener<S> = (state: S) => void;

export class Store<S> {
  private listeners: Listener<S>[] = [];
  private state: S;

  // Fields are declared and assigned rather than declared in the parameter
  // list: constructor parameter properties emit code, and this runs under
  // node's type-stripping, which only removes types.
  constructor(initial: S) {
    this.state = initial;
  }

  get(): S {
    return this.state;
  }

  set(next: Partial<S>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l(this.state);
  }

  subscribe(listener: Listener<S>): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}
