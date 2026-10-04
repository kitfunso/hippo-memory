// First-class object verbs for predictions, decisions and incidents.

import { MemoryEntry } from '../memory.js';
import { writeEntry, readEntry } from '../store.js';
import { extractPathTags } from '../path-context.js';
import * as predictionsModule from '../predictions.js';
import * as decisionsModule from '../decisions.js';
import * as incidentsModule from '../incidents.js';
import { resolveTenantId } from '../tenant.js';
import { printError } from './output.js';
import { requireInit } from './shared.js';

// ---------------------------------------------------------------------------
// E2 prediction first-class object (v0.31)
// docs/plans/2026-05-26-e2-prediction-object.md
// ---------------------------------------------------------------------------

export function cmdPredict(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      printError('Usage: hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]');
      process.exit(1);
    }
    const id = parseInt(String(idRaw), 10);
    if (!Number.isFinite(id) || id <= 0) {
      printError(`Invalid prediction id: "${idRaw}"`);
      process.exit(1);
    }
    const stateRaw = typeof flags['state'] === 'string' ? flags['state'].trim() : '';
    if (!predictionsModule.VALID_CLOSURE_STATES.has(stateRaw as predictionsModule.ClosureState) || stateRaw === 'open') {
      printError(`Invalid --state: "${stateRaw}". Must be one of: closed | closed-unknown.`);
      process.exit(1);
    }
    const actualRaw = flags['actual'];
    const actualValue = actualRaw !== undefined ? Number(actualRaw) : undefined;
    if (actualRaw !== undefined && !Number.isFinite(actualValue)) {
      printError(`Invalid --actual: "${actualRaw}". Must be a number.`);
      process.exit(1);
    }
    const noteRaw = flags['note'];
    const closureNote = typeof noteRaw === 'string' ? noteRaw : undefined;

    const closed = predictionsModule.closePrediction(hippoRoot, tenantId, id, {
      closureState: stateRaw as predictionsModule.ClosureState,
      actualValue,
      closureNote,
    });
    console.log(`Prediction ${closed.id} closed: state=${closed.closureState}${closed.actualValue !== null ? ` actual=${closed.actualValue}` : ''}`);
    return;
  }

  if (subcommand === 'list') {
    const classTagRaw = flags['class'];
    const classTag = typeof classTagRaw === 'string' ? classTagRaw.trim() : '';
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      printError(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }

    let results;
    if (status === 'open') {
      results = predictionsModule.loadOpenPredictions(hippoRoot, tenantId, {
        classTag: classTag || undefined,
        limit,
      });
    } else if (status === 'all') {
      // No closure-state filter; pull both via loadPredictionsByClass if class given
      if (classTag) {
        results = predictionsModule.loadPredictionsByClass(hippoRoot, tenantId, classTag, { limit });
      } else {
        // No class filter + status=all = pull open + closed across all classes
        // (kept simple: report open via loadOpenPredictions; closed via two
        // class scans isn't symmetrical. v1 callers typically pass --class.)
        results = predictionsModule.loadOpenPredictions(hippoRoot, tenantId, { limit });
      }
    } else {
      if (!predictionsModule.VALID_CLOSURE_STATES.has(status as predictionsModule.ClosureState)) {
        printError(`Invalid --status: "${status}". Must be one of: open | closed | closed-unknown | all.`);
        process.exit(1);
      }
      if (classTag) {
        results = predictionsModule.loadPredictionsByClass(hippoRoot, tenantId, classTag, {
          closureState: status as predictionsModule.ClosureState,
          limit,
        });
      } else {
        // status filter without class — scan all classes is more complex; v1 requires --class for non-default status
        printError('--status filter (non-open) requires --class to be set.');
        process.exit(1);
      }
    }

    if (results.length === 0) {
      console.log(classTag ? `No predictions in class "${classTag}".` : 'No predictions.');
      return;
    }
    console.log(`Found ${results.length} predictions:\n`);
    for (const p of results) {
      const estPart = p.estimateValue !== null ? ` estimate=${p.estimateValue}${p.estimateUnit ? ` ${p.estimateUnit}` : ''}` : '';
      const actPart = p.actualValue !== null ? ` actual=${p.actualValue}` : '';
      const tgtPart = p.targetDate ? ` target=${p.targetDate}` : '';
      console.log(`#${p.id} [${p.closureState}] class=${p.classTag}${estPart}${actPart}${tgtPart}`);
      console.log(`    ${p.claimText}`);
      if (p.closureNote) console.log(`    note: ${p.closureNote}`);
    }
    return;
  }

  if (subcommand === 'show') {
    const idRaw = args[1];
    if (!idRaw) {
      printError('Usage: hippo predict show <id>');
      process.exit(1);
    }
    const id = parseInt(String(idRaw), 10);
    if (!Number.isFinite(id) || id <= 0) {
      printError(`Invalid prediction id: "${idRaw}"`);
      process.exit(1);
    }
    const pred = predictionsModule.loadPredictionById(hippoRoot, tenantId, id);
    if (!pred) {
      printError(`Prediction ${id} not found.`);
      process.exit(1);
    }
    console.log(`Prediction #${pred.id}`);
    console.log(`  class: ${pred.classTag}`);
    console.log(`  claim: ${pred.claimText}`);
    console.log(`  state: ${pred.closureState}`);
    if (pred.estimateValue !== null) console.log(`  estimate: ${pred.estimateValue}${pred.estimateUnit ? ' ' + pred.estimateUnit : ''}`);
    if (pred.targetDate) console.log(`  target: ${pred.targetDate}`);
    if (pred.actualValue !== null) console.log(`  actual: ${pred.actualValue}`);
    if (pred.closedAt) console.log(`  closed: ${pred.closedAt}`);
    if (pred.closureNote) console.log(`  note: ${pred.closureNote}`);
    if (pred.memoryId) console.log(`  memory: ${pred.memoryId}`);
    console.log(`  created: ${pred.createdAt}`);
    return;
  }

  if (subcommand === 'baserate') {
    // J3 reference-class / planning-fallacy detector
    const classTagRaw = flags['class'];
    if (typeof classTagRaw !== 'string' || !classTagRaw.trim()) {
      printError('Usage: hippo predict baserate --class <c>');
      process.exit(1);
    }
    const baserate = predictionsModule.computePredictionBaserate(
      hippoRoot,
      tenantId,
      classTagRaw.trim(),
    );
    if (baserate.nClosed === 0) {
      console.log(`No closed predictions in class "${baserate.classTag}" yet.`);
      console.log(`  Create one with: hippo predict "<claim>" --class ${baserate.classTag} --estimate N`);
      console.log(`  Close it later:  hippo predict close <id> --state closed --actual N`);
      return;
    }
    console.log(baserate.summary);
    console.log(`  n_closed:         ${baserate.nClosed}`);
    console.log(`  n_ratio_eligible: ${baserate.nRatioEligible}`);
    if (baserate.meanEstimate !== null) console.log(`  mean_estimate:    ${baserate.meanEstimate.toFixed(3)}`);
    if (baserate.meanActual !== null)   console.log(`  mean_actual:      ${baserate.meanActual.toFixed(3)}`);
    if (baserate.meanRatio !== null)    console.log(`  mean_ratio:       ${baserate.meanRatio.toFixed(3)}x`);
    if (baserate.p50Ratio !== null)     console.log(`  p50_ratio:        ${baserate.p50Ratio.toFixed(3)}x`);
    if (baserate.mae !== null)          console.log(`  mae:              ${baserate.mae.toFixed(3)}`);
    return;
  }

  // Default subcommand: create. args[0] is the claim text.
  const claimText = subcommand;
  if (!claimText) {
    printError('Usage: hippo predict "<claim>" --class <c> [--estimate <v>] [--unit <u>] [--target <YYYY-MM-DD>]');
    printError('       hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]');
    printError('       hippo predict list [--class X] [--status open|closed|closed-unknown|all] [--limit N]');
    printError('       hippo predict show <id>');
    process.exit(1);
  }
  const classTagRaw = flags['class'];
  if (typeof classTagRaw !== 'string' || !classTagRaw.trim()) {
    printError('--class is required for prediction creation.');
    process.exit(1);
  }
  const classTag = classTagRaw.trim();
  const estimateRaw = flags['estimate'];
  const estimateValue = estimateRaw !== undefined ? Number(estimateRaw) : undefined;
  if (estimateRaw !== undefined && !Number.isFinite(estimateValue)) {
    printError(`Invalid --estimate: "${estimateRaw}". Must be a number.`);
    process.exit(1);
  }
  const unitRaw = flags['unit'];
  const estimateUnit = typeof unitRaw === 'string' ? unitRaw : undefined;
  const targetRaw = flags['target'];
  const targetDate = typeof targetRaw === 'string' ? targetRaw : undefined;

  const created = predictionsModule.savePrediction(hippoRoot, tenantId, {
    classTag,
    claimText,
    estimateValue,
    estimateUnit,
    targetDate,
  });
  console.log(`Prediction recorded: #${created.id} class=${created.classTag}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
}

export function cmdDecide(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      printError(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    let results;
    if (status === 'all') {
      results = decisionsModule.loadDecisions(hippoRoot, tenantId, { limit });
    } else {
      if (!decisionsModule.VALID_DECISION_STATES.has(status as decisionsModule.DecisionStatus)) {
        printError(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
        process.exit(1);
      }
      results = decisionsModule.loadDecisions(hippoRoot, tenantId, {
        status: status as decisionsModule.DecisionStatus,
        limit,
      });
    }
    if (results.length === 0) {
      console.log('No decisions.');
      return;
    }
    console.log(`Found ${results.length} decisions:\n`);
    for (const d of results) {
      const supPart = d.supersededBy !== null ? ` superseded_by=#${d.supersededBy}` : '';
      console.log(`#${d.id} [${d.status}]${supPart} memory=${d.memoryId ?? '-'}`);
      console.log(`    ${d.decisionText}`);
      if (d.context) console.log(`    context: ${d.context}`);
    }
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      printError('Usage: hippo decide get <id>');
      process.exit(1);
    }
    const id = parseInt(String(idRaw), 10);
    if (!Number.isFinite(id) || id <= 0) {
      printError(`Invalid decision id: "${idRaw}"`);
      process.exit(1);
    }
    const decision = decisionsModule.loadDecisionById(hippoRoot, tenantId, id);
    if (!decision) {
      printError(`Decision ${id} not found.`);
      process.exit(1);
    }
    console.log(`Decision #${decision.id}`);
    console.log(`  status: ${decision.status}`);
    console.log(`  text: ${decision.decisionText}`);
    if (decision.context) console.log(`  context: ${decision.context}`);
    if (decision.supersededBy !== null) console.log(`  superseded_by: #${decision.supersededBy}`);
    if (decision.supersededAt) console.log(`  superseded_at: ${decision.supersededAt}`);
    if (decision.closedAt) console.log(`  closed_at: ${decision.closedAt}`);
    if (decision.memoryId) console.log(`  memory: ${decision.memoryId}`);
    console.log(`  created: ${decision.createdAt}`);
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      printError('Usage: hippo decide close <id>');
      process.exit(1);
    }
    const id = parseInt(String(idRaw), 10);
    if (!Number.isFinite(id) || id <= 0) {
      printError(`Invalid decision id: "${idRaw}"`);
      process.exit(1);
    }
    const closed = decisionsModule.closeDecision(hippoRoot, tenantId, id);
    console.log(`Decision #${closed.id} closed.`);
    return;
  }

  // Default subcommand: create. args[0] is the decision text.
  const decisionText = subcommand;
  if (!decisionText) {
    printError('Usage: hippo decide "<decision>" [--context "<why>"] [--supersedes <memory-id>]');
    printError('       hippo decide list [--status active|superseded|closed|all] [--limit N]');
    printError('       hippo decide get <id>');
    printError('       hippo decide close <id>');
    process.exit(1);
  }
  const contextRaw = flags['context'];
  const context = typeof contextRaw === 'string' && contextRaw ? contextRaw : undefined;
  // A value-less `--supersedes` (parseArgs stores boolean true) is a malformed
  // request: the user asked to supersede but gave no memory id. Reject it rather
  // than silently creating a non-superseding decision (codex review 2026-05-28).
  if (flags['supersedes'] === true) {
    printError('--supersedes requires a memory id, e.g. hippo decide "<text>" --supersedes mem_abc123.');
    process.exit(1);
  }
  const supersedesMemId = typeof flags['supersedes'] === 'string' ? flags['supersedes'] : null;

  // Backward-compat: --supersedes takes a MEMORY id. Validate it exists and
  // resolve it to the active decision row (if any). Grill fix: commit the
  // canonical table create+supersede FIRST (inside saveDecision's SAVEPOINT),
  // weaken the old memory LAST (best-effort) so a memory-write failure cannot
  // leave the memory stale without the table reflecting the supersession.
  let supersedesDecisionId: number | undefined;
  let oldEntry: MemoryEntry | null = null;
  if (supersedesMemId) {
    oldEntry = readEntry(hippoRoot, supersedesMemId, tenantId) ?? null;
    if (!oldEntry) {
      printError(`Memory ${supersedesMemId} not found.`);
      process.exit(1);
    }
    supersedesDecisionId =
      decisionsModule.resolveActiveDecisionIdByMemory(hippoRoot, tenantId, supersedesMemId) ?? undefined;
  }

  const decisionPathTags = extractPathTags(process.cwd());
  const created = decisionsModule.saveDecision(hippoRoot, tenantId, {
    decisionText,
    context,
    supersedesDecisionId,
    extraTags: decisionPathTags,
  });

  // Legacy memory-weaken (best-effort, LAST): half-life halved, marked stale +
  // 'superseded' tag. Preserves the exact pre-promotion behavior for the memory
  // mirror; the canonical table supersession already committed above.
  if (oldEntry) {
    // Best-effort: saveDecision already committed the canonical mutation (new
    // decision created + old row superseded). If this legacy memory-weaken
    // throws, do NOT fail the command — a retry would find no active decision
    // for the old memory and create a duplicate active successor. Warn instead
    // (codex review 2026-05-28).
    try {
      oldEntry.half_life_days = Math.max(1, Math.floor(oldEntry.half_life_days / 2));
      oldEntry.confidence = 'stale';
      if (!oldEntry.tags.includes('superseded')) oldEntry.tags.push('superseded');
      writeEntry(hippoRoot, oldEntry);
    } catch (e) {
      printError(`  warning: decision recorded and superseded, but failed to weaken the prior memory ${supersedesMemId}: ${(e as Error).message}`);
    }
  }

  console.log(`Decision recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (supersedesMemId) {
    const tail =
      supersedesDecisionId !== undefined
        ? ` (decision #${supersedesDecisionId} superseded)`
        : ' (no active decision row; memory weakened only)';
    console.log(`  supersedes memory: ${supersedesMemId}${tail}`);
  }
}

// Strict positive-integer parse for incident id args. parseInt() alone accepts
// trailing junk ("1abc" -> 1), which would let a mutating subcommand (close/
// resolve) silently hit the wrong row; require the whole arg to be digits.
// (codex P2, 2026-05-29.)
function parsePositiveIncidentId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    printError(`Invalid incident id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

export function cmdIncident(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      printError(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    let results;
    if (status === 'all') {
      results = incidentsModule.loadIncidents(hippoRoot, tenantId, { limit });
    } else {
      if (!incidentsModule.VALID_INCIDENT_STATES.has(status as incidentsModule.IncidentStatus)) {
        printError(`Invalid --status: "${status}". Must be one of: open | resolved | closed | all.`);
        process.exit(1);
      }
      results = incidentsModule.loadIncidents(hippoRoot, tenantId, {
        status: status as incidentsModule.IncidentStatus,
        limit,
      });
    }
    if (results.length === 0) {
      console.log('No incidents.');
      return;
    }
    console.log(`Found ${results.length} incidents:\n`);
    for (const inc of results) {
      const linkPart = inc.linkedMemoryIds.length > 0 ? ` links=${inc.linkedMemoryIds.length}` : '';
      console.log(`#${inc.id} [${inc.status}]${linkPart} memory=${inc.memoryId ?? '-'}`);
      console.log(`    ${inc.incidentText}`);
      if (inc.context) console.log(`    context: ${inc.context}`);
    }
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      printError('Usage: hippo incident get <id>');
      process.exit(1);
    }
    const id = parsePositiveIncidentId(idRaw);
    const incident = incidentsModule.loadIncidentById(hippoRoot, tenantId, id);
    if (!incident) {
      printError(`Incident ${id} not found.`);
      process.exit(1);
    }
    console.log(`Incident #${incident.id}`);
    console.log(`  status: ${incident.status}`);
    console.log(`  text: ${incident.incidentText}`);
    if (incident.context) console.log(`  context: ${incident.context}`);
    if (incident.resolutionText) console.log(`  resolution: ${incident.resolutionText}`);
    if (incident.resolvedAt) console.log(`  resolved_at: ${incident.resolvedAt}`);
    if (incident.closedAt) console.log(`  closed_at: ${incident.closedAt}`);
    if (incident.linkedMemoryIds.length > 0) {
      console.log(`  linked memories: ${incident.linkedMemoryIds.join(', ')}`);
    }
    if (incident.memoryId) console.log(`  memory: ${incident.memoryId}`);
    console.log(`  created: ${incident.createdAt}`);
    return;
  }

  if (subcommand === 'resolve') {
    const idRaw = args[1];
    if (!idRaw) {
      printError('Usage: hippo incident resolve <id> --resolution "<text>"');
      process.exit(1);
    }
    const id = parsePositiveIncidentId(idRaw);
    const resolutionRaw = flags['resolution'];
    if (typeof resolutionRaw !== 'string' || !resolutionRaw.trim()) {
      printError('--resolution requires a non-empty value, e.g. hippo incident resolve <id> --resolution "root cause fixed".');
      process.exit(1);
    }
    const resolved = incidentsModule.resolveIncident(hippoRoot, tenantId, id, resolutionRaw);
    console.log(`Incident #${resolved.id} resolved.`);
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      printError('Usage: hippo incident close <id>');
      process.exit(1);
    }
    const id = parsePositiveIncidentId(idRaw);
    const closed = incidentsModule.closeIncident(hippoRoot, tenantId, id);
    console.log(`Incident #${closed.id} closed.`);
    return;
  }

  // Default subcommand: open (create). Accept both the documented
  // `incident open "<text>"` form and the bare `incident "<text>"` form: for the
  // `open` keyword the text is args[1], otherwise args[0] IS the text.
  const incidentText = subcommand === 'open' ? (args[1] ?? '') : subcommand;
  if (!incidentText) {
    printError('Usage: hippo incident "<incident>" [--context "<details>"] [--link <memory-id>]...');
    printError('       hippo incident list [--status open|resolved|closed|all] [--limit N]');
    printError('       hippo incident get <id>');
    printError('       hippo incident resolve <id> --resolution "<text>"');
    printError('       hippo incident close <id>');
    process.exit(1);
  }
  const contextRaw = flags['context'];
  const context = typeof contextRaw === 'string' && contextRaw ? contextRaw : undefined;
  // --link is a repeatable flag (collected into an array by parseArgs). A
  // single --link <id> yields a string; normalize both to string[].
  const linkRaw = flags['link'];
  let linkedMemoryIds: string[] | undefined;
  if (Array.isArray(linkRaw)) {
    linkedMemoryIds = linkRaw;
  } else if (typeof linkRaw === 'string') {
    linkedMemoryIds = [linkRaw];
  } else if (linkRaw === true) {
    printError('--link requires a memory id, e.g. hippo incident "<text>" --link mem_abc123.');
    process.exit(1);
  }

  const incidentPathTags = extractPathTags(process.cwd());
  const created = incidentsModule.saveIncident(hippoRoot, tenantId, {
    incidentText,
    context,
    linkedMemoryIds,
    extraTags: incidentPathTags,
  });

  console.log(`Incident recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (created.linkedMemoryIds.length > 0) {
    console.log(`  linked memories: ${created.linkedMemoryIds.join(', ')}`);
  }
}
