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
const missing = () => new ApiError(404, 'NOT_FOUND', 'Resource not found.');
const limit = () => new ApiError(413, 'LIMIT_REACHED', 'The library limit has been reached.');
module.exports = { ApiError, invalid, missing, limit };
