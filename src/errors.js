'use strict';

class ApiError extends Error {
  constructor(status, code, message = code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const invalid = (message) => new ApiError(400, 'INVALID_BODY', message);
const missing = () => new ApiError(404, 'NOT_FOUND', 'No existe ese recurso.');
const limit = () => new ApiError(413, 'LIMIT_REACHED', 'Se ha alcanzado el límite de la biblioteca.');
module.exports = { ApiError, invalid, missing, limit };
