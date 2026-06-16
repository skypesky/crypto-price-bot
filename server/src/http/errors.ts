export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = 'bad request', code = 'bad_request') {
    super(400, code, message);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'unauthorized', code = 'unauthorized') {
    super(401, code, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'forbidden', code = 'forbidden') {
    super(403, code, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'not found', code = 'not_found') {
    super(404, code, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'conflict', code = 'conflict') {
    super(409, code, message);
  }
}

export class InternalError extends HttpError {
  constructor(message = 'internal error', code = 'internal_error') {
    super(500, code, message);
  }
}