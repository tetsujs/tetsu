import { getEntry } from "astro:content";

/**
 * The path of a page's Markdown version, or `undefined` when it has none.
 *
 * `pages/[...slug].md.ts` serves one for every page of the docs collection.
 * Pages made by code, such as the blog's index and author pages, are not in
 * the collection, so they have none, even though they have a sidebar.
 */
export async function markdownPath(id: string): Promise<string | undefined> {
  if (!id) return undefined;

  const page = await getEntry("docs", id);

  return page && !page.data.draft ? `/${id}.md` : undefined;
}
