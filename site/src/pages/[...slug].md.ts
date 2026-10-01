import { type CollectionEntry, getCollection } from "astro:content";
import type { APIRoute, GetStaticPaths } from "astro";
// The converter `llms-full.txt` is made with, so a page's Markdown is the same text, cleaned
// the same way. The package exports only its integration; the version is pinned.
import { entryToSimpleMarkdown } from "../../node_modules/starlight-llms-txt/entryToSimpleMarkdown.ts";

export const getStaticPaths = (async () => {
  const entries = await getCollection("docs", (entry) => !entry.data.draft);

  return entries.map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: CollectionEntry<"docs"> }> = async (
  context,
) => {
  const { entry } = context.props;
  const { title, description } = entry.data;
  const body = await entryToSimpleMarkdown(entry, context);
  const lead = description ? `\n\n> ${description}` : "";

  return new Response(`# ${title}${lead}\n\n${body}\n`, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
