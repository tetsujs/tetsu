const lines = [
  'import { controller, createApp, httpError, route } from "@tetsujs/core";',
  'import { z } from "zod";',
  "",
  'const users = controller("Users", ({ repo }: { repo: UserRepository }) => ({',
  "  get: route({",
  '    method: "GET",',
  '    path: "/users/:id",',
  "    schema: { params: z.object({ id: z.coerce.number() }) },",
  "    handler: (ctx) => {",
  "      const user = repo.find(ctx.params.id);",
  '      if (!user) throw httpError(404, "USER_NOT_FOUND");',
  "      return user;",
  "    },",
  "  }),",
  "}));",
  "",
  "Bun.serve({ ...createApp({ routes: users({ repo }) }) });",
];

const find = lines[9] as string;
const query = `${" ".repeat(6)}//${" ".repeat(find.lastIndexOf("id") - 8)}^?`;

const prelude = [
  "interface User { id: number; name: string }",
  "interface UserRepository { find(id: number): User | undefined }",
  "declare const repo: UserRepository;",
  "// ---cut---",
];

export const heroCode = [
  ...prelude,
  ...lines.slice(0, 10),
  query,
  ...lines.slice(10),
].join("\n");

export const install = "bun add @tetsujs/core";
