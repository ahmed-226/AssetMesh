// Typed application errors. Carrying the HTTP status here (instead of letting
// http code reach into domain) keeps "how to speak HTTP" out of the domain;
// the http layer just maps statusCode → response in one place.
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class PayloadTooLargeError extends AppError {
  constructor() {
    super(413, "Payload too large")
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, message)
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, message)
  }
}