// A request id stays with the session that first used it, once for both adapters: sessions are owner-bound, so the
// refusal also keeps one owner from reading or finishing another's record.
import { ConflictError } from '../../base/errors/api-errors.js';

export const otherSessionsRequest = (): ConflictError => new ConflictError('request id belongs to another session');
