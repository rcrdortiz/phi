import { debounce } from "../util/debounce.ts";

export interface SearchBoxOptions {
  onSearch: (term: string) => void;
  minLength?: number;
  waitMs?: number;
}

/** A search box that only asks the server once typing settles, and never for a
 *  term too short to be worth a round trip. */
export function createSearchBox(options: SearchBoxOptions) {
  const min = options.minLength ?? 2;
  const run = debounce((term: string) => options.onSearch(term), options.waitMs ?? 250);
  return {
    type(term: string): void {
      const trimmed = term.trim();
      if (trimmed.length < min) return;
      run(trimmed);
    },
  };
}
