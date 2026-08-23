/** A tiny synchronous event bus. */
export function createBus() {
  const handlers = new Map();
  return {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    emit(name, payload) { for (const fn of handlers.get(name) ?? []) fn(payload); },
  };
}
