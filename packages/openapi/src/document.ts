/**
 * The shape of the documents this package produces.
 *
 * Typed only as far as the generator fills it in: an OpenAPI document is
 * far larger than what a route table can honestly describe, and declaring
 * the rest would promise support that does not exist. Everything typed
 * here is emitted; everything a caller adds by hand passes through the
 * index signatures.
 *
 * OpenAPI 3.1 only. It is JSON Schema 2020-12 verbatim, which is what
 * validators emit through Standard Schema — 3.0 would mean converting the
 * dialect and being subtly wrong about `nullable`, `examples` and binary
 * payloads.
 *
 * @module
 */

/** Metadata every OpenAPI document must carry. */
export interface DocumentInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

/** A server the API is reachable at. */
export interface DocumentServer {
  readonly url: string;
  readonly description?: string;
}

/** One request parameter: a path segment, a query key or a header. */
export interface ParameterObject {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly description?: string;
  readonly schema?: Record<string, unknown>;
}

/** A body or response payload, keyed by media type. */
export type ContentMap = Record<
  string,
  { readonly schema?: Record<string, unknown> }
>;

/** One response of an operation. */
export interface ResponseObject {
  readonly description: string;
  readonly content?: ContentMap;
}

/** One endpoint: a method on a path. */
export interface OperationObject {
  readonly operationId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
  readonly parameters?: readonly ParameterObject[];
  readonly requestBody?: {
    readonly required: boolean;
    readonly content: ContentMap;
  };
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly responses: Record<string, ResponseObject>;
}

/** Every operation declared on one path template. */
export type PathItemObject = Record<string, OperationObject>;

/** The generated document. */
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: DocumentInfo;
  readonly servers?: readonly DocumentServer[];
  readonly paths: Record<string, PathItemObject>;

  /**
   * What the operations refer to rather than repeat: the security schemes
   * the guards registered, and the failure envelopes the framework fills
   * in. Absent when neither has anything to say.
   */
  readonly components?: {
    readonly securitySchemes?: Record<string, unknown>;
    readonly schemas?: Record<string, unknown>;
  };

  readonly [key: string]: unknown;
}
