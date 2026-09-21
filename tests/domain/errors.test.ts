import { describe, expect, it } from "vitest"
import { AppError, BadRequestError, PayloadTooLargeError } from "../../src/domain/errors.js"

describe("AppError", () => {
  it("carries statusCode and message and identifies itself by subclass name", () => {
    const err = new AppError(418, "teapot")
    expect(err).toBeInstanceOf(Error)
    expect(err.statusCode).toBe(418)
    expect(err.message).toBe("teapot")
    expect(err.name).toBe("AppError")
  })
})

describe("PayloadTooLargeError", () => {
  it("is an AppError with status 413", () => {
    const err = new PayloadTooLargeError()
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(413)
    expect(err.message).toBe("Payload too large")
    expect(err.name).toBe("PayloadTooLargeError")
  })
})

describe("BadRequestError", () => {
  it("is an AppError with status 400 and the given message", () => {
    const err = new BadRequestError("multipart field 'file' is required")
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe("multipart field 'file' is required")
    expect(err.name).toBe("BadRequestError")
  })
})