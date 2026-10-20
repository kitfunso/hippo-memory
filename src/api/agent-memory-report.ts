// What an agent-memory import reports: the tallies a verb sums across stores and the lines it prints. Kept apart from
// the importers, so a printer loads it without them.

export {
  detailLines,
  emptyReport,
  mergeReports,
  summaryLine,
  type ImportReport,
} from '../domain/agent-memories/report.js';
