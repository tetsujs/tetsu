/**
 * A file upload, validated like any other field.
 *
 * `bodyType: "form"` parses multipart and urlencoded bodies; a file arrives
 * in `ctx.body` as a `File` and is checked by the schema — size and type
 * included — with `file()` from `@tetsujs/typebox`. `maxBodySize` raises
 * the ceiling for this route alone.
 *
 * ```sh
 * bun examples/uploads.ts
 * curl -F title=logo -F image=@some.png localhost:3000/images
 * curl -F title=logo -F image=@notes.txt localhost:3000/images   # 422, image
 * ```
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";
import { file, Type, tb } from "@tetsujs/typebox";

const ImageUpload = tb(
  Type.Object({
    title: Type.String({ minLength: 1 }),
    image: file({ maxSize: "2m", type: "image" }),
  }),
);

class ImagesController {
  upload = route({
    method: "POST",
    path: "/images",
    bodyType: "form",
    maxBodySize: 3 * 1024 * 1024,
    schema: { body: ImageUpload },
    handler: async (ctx) => {
      const { title, image } = ctx.body;

      ctx.out.status = 201;

      return {
        title,
        name: image.name,
        type: image.type,
        bytes: (await image.arrayBuffer()).byteLength,
      };
    },
  });
}

export default createApp({ routes: new ImagesController() });
