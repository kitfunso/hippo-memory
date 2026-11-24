import { ConflictError } from '../../base/errors/api-errors.js';

export const otherSessionsRequest = (): ConflictError =>
  new ConflictError('request id belongs to another session');
