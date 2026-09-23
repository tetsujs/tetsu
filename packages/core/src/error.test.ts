/**
 * Runtime tests for pipeline errors.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import {
  errorBody,
  HttpError,
  httpError,
  serializedBody,
  ValidationError,
} from "./error.ts";

describe("HttpError", () => {
  test("is an Error carrying the status", () => {
    const error = new HttpError(404);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HttpError");
    expect(error.status).toBe(404);
    expect(error.message).toBe("Not Found");
  });

  test("uses a string body as the message", () => {
    const error = new HttpError(403, "Not your order");

    expect(error.status).toBe(403);
    expect(error.body).toBe("Not your order");
    expect(error.message).toBe("Not your order");
  });
});

describe("ValidationError", () => {
  const issues = [
    { message: "id must be an integer", path: ["params", "id"] },
    { message: "qty must be a number", path: ["body", "items", 0, "qty"] },
  ];

  test("is catchable as both an HttpError and itself", () => {
    const error = new ValidationError(422, issues);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ValidationError");
  });

  test("exposes the issues directly", () => {
    const error = new ValidationError(422, issues);

    expect(error.issues).toEqual(issues);
    expect(error.issues[1]?.path).toEqual(["body", "items", 0, "qty"]);
  });

  test("serializes through the standard error body", () => {
    const error = new ValidationError(400, issues);

    expect(error.status).toBe(400);
    expect(error.body).toEqual({
      status: 400,
      message: "Validation failed",
      error: "VALIDATION_FAILED",
      issues,
    });
  });
});

describe("the error envelope", () => {
  test("defaults both halves to the status", () => {
    expect(errorBody(404)).toEqual({
      status: 404,
      message: "Not Found",
      error: "NOT_FOUND",
    });
  });

  test("derives the code from the reason phrase, apostrophes dropped", () => {
    expect(errorBody(418).error).toBe("IM_A_TEAPOT");
    expect(errorBody(505).error).toBe("HTTP_VERSION_NOT_SUPPORTED");
  });

  test("falls back to the status itself outside the table", () => {
    expect(errorBody(499)).toEqual({
      status: 499,
      message: "HTTP 499",
      error: "HTTP_499",
    });
  });

  test("takes the code and the message from the caller", () => {
    expect(errorBody(400, "MALFORMED_JSON", "Body is not valid JSON")).toEqual({
      status: 400,
      message: "Body is not valid JSON",
      error: "MALFORMED_JSON",
    });
  });

  test("httpError carries the envelope as the body", () => {
    const error = httpError(401, "SESSION_EXPIRED", "Session expired");

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Session expired");
    expect(error.body).toEqual({
      status: 401,
      message: "Session expired",
      error: "SESSION_EXPIRED",
    });
  });
});

describe("what an HttpError serializes as", () => {
  test("no body is the envelope for the status", () => {
    expect(serializedBody(new HttpError(404))).toEqual({
      status: 404,
      message: "Not Found",
      error: "NOT_FOUND",
    });
  });

  test("a string body becomes the envelope's message", () => {
    expect(serializedBody(new HttpError(403, "Not your order"))).toEqual({
      status: 403,
      message: "Not your order",
      error: "FORBIDDEN",
    });
  });

  test("any other body goes out verbatim, status not injected", () => {
    const body = { error: "ACCOUNT_LOCKED", status: "suspended" };

    expect(serializedBody(new HttpError(403, body))).toBe(body);
  });
});
