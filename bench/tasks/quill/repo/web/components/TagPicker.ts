import type { Tag } from "../api/types.ts";

export const MAX_TAGS = 5;

export function toggleTag(selected: string[], slug: string): string[] {
  if (selected.includes(slug)) return selected.filter((s) => s !== slug);
  if (selected.length >= MAX_TAGS) return selected;
  return [...selected, slug];
}

export function renderTagPicker(all: Tag[], selected: string[]): string {
  const options = all
    .map((t) => {
      const on = selected.includes(t.slug) ? " is-selected" : "";
      return `  <button class="tag-option${on}" data-slug="${t.slug}">${t.name}</button>`;
    })
    .join("\n");
  return `<div class="tag-picker">\n${options}\n</div>`;
}
