export const meta = {
  name: 'horizon-execute-wave',
  description: 'Stage 2: implement → gate → PR → multi-reviewer → revise → auto-merge for a wave of clusters (sequential clusters, parallel reviewers). Cluster ids passed via args.',
  phases: [
    { title: 'Implement', detail: 'developer implements each cluster on a branch cut from the live integration tip' },
    { title: 'Review', detail: '3 adversarial reviewers per PR (correctness / security+pattern / tests+gate)' },
    { title: 'Merge', detail: 'auto-merge approved + green PRs into the integration branch' },
  ],
}

const root = '/Users/luuk/Projects/slimluccii/horizon'
const INTEG = 'review/expert-fixes'
const ctx = `Repo root: ${root} (run all git/gh/npm from here unless told otherwise). Horizon = self-hosted media server monorepo: apps/server (Fastify + better-sqlite3 + ffmpeg, TS/ESM), apps/web (React 18 + hls.js + Vite), libs/sdk (TS client), apps/macos (Swift), apps/android-tv (Kotlin). Read CONTEXT.md for domain language. REUSE existing patterns: resolveCallerRole/requireUser (authz), Zod .strict() (validation), waitForExit (ffmpeg lifecycle). BASELINE (pre-existing, NOT your fault, must not increase): server 'cd apps/server && npx tsc --noEmit' yields exactly 4 errors, all in test/ (metadata.refresh.test.ts lines 82/92, scanner.manager.test.ts line 72); 266 server tests pass; web+sdk tsc clean.`

// cluster registry — issues listed in implement order (internalOrder from the plan)
const REG = {
  'foundation-authz':            { issues: [60],                          gate: 'server' },
  'foundation-errors':           { issues: [40],                          gate: 'server-sdk' },
  'sdk-core':                    { issues: [51,52,73,75,53,74],           gate: 'sdk' },
  'sessions-core':               { issues: [62,33,34,44,71,77,47,48,42],  gate: 'server' },
  'library-routes':              { issues: [30,32,39,45,46,64],           gate: 'server' },
  'users-security':              { issues: [43,54,55,56],                 gate: 'server' },
  'segments-playlists-security': { issues: [86,89,78,88],                 gate: 'server' },
  'auth-refactor':               { issues: [41],                          gate: 'server' },
  'db-media':                    { issues: [63,67,49,50,61,65,72,87,76,66], gate: 'server' },
  'transcode':                   { issues: [57,90,58,79,80],              gate: 'server' },
  'web':                         { issues: [81,82,83,84],                 gate: 'web' },
  'macos':                       { issues: [31,68,69,70,85],              gate: 'none' },
  'androidtv':                   { issues: [36,37,35,38,59],              gate: 'none' },
}

const GATE_DESC = {
  'server': `cd apps/server && npx tsc --noEmit  → error count must stay 4 (the known baseline lines ONLY; zero NEW errors). Then 'npm -w @horizon/server run test' → all prior 266 tests plus your new tests pass.`,
  'sdk': `cd libs/sdk && npx tsc --noEmit → 0 errors. Then 'npm -w @horizon/sdk run test' → all pass incl. new tests.`,
  'server-sdk': `Run BOTH the server gate (cd apps/server && npx tsc --noEmit stays at 4 baseline errors; npm -w @horizon/server run test passes) AND the sdk gate (cd libs/sdk && npx tsc --noEmit = 0; npm -w @horizon/sdk run test passes).`,
  'web': `cd apps/web && npx tsc --noEmit → 0 errors. (No web test runner configured; rely on typecheck + careful review.)`,
  'none': `No compile/test toolchain available in this environment for native (Swift/Kotlin). Do NOT attempt to build. Implement precisely by reading; document explicit manual-verification steps in the commit/PR body for a human/CI to run later.`,
}

let parsedArgs = args
if (typeof parsedArgs === 'string') {
  const s = parsedArgs.trim()
  if (s.startsWith('[')) { try { parsedArgs = JSON.parse(s) } catch { parsedArgs = s.split(/[\s,]+/) } }
  else parsedArgs = s.split(/[\s,]+/)
}
const waveIds = (Array.isArray(parsedArgs) ? parsedArgs : (parsedArgs ? [parsedArgs] : [])).map(x => String(x).trim()).filter(id => REG[id])
if (!waveIds.length) { log('No valid cluster ids in args; nothing to do.'); return { error: 'no clusters', argsSeen: args } }
log(`Wave clusters: ${waveIds.join(', ')}`)

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['cluster','branch','issuesDone','gatePass','gateNotes','prNumber','prUrl','summary'],
  properties: {
    cluster: { type: 'string' }, branch: { type: 'string' },
    issuesDone: { type: 'array', items: { type: 'integer' } },
    gatePass: { type: 'boolean' }, gateNotes: { type: 'string' },
    prNumber: { type: 'integer', description: '0 if PR not opened (gate failed)' },
    prUrl: { type: 'string' }, summary: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens','decision','blockingItems','notes'],
  properties: {
    lens: { type: 'string' },
    decision: { type: 'string', enum: ['approve','request-changes'] },
    blockingItems: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['issue','file','problem','requiredChange'],
      properties: { issue: { type: 'integer' }, file: { type: 'string' }, problem: { type: 'string' }, requiredChange: { type: 'string' } } } },
    notes: { type: 'string' },
  },
}
const REVISE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['gatePass','addressed','summary'],
  properties: { gatePass: { type: 'boolean' }, addressed: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } },
}
const MERGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['merged','sha','notes'],
  properties: { merged: { type: 'boolean' }, sha: { type: 'string' }, notes: { type: 'string' } },
}

const LENSES = [
  { key: 'correctness', focus: 'Correctness & regressions: does each change actually fix its issue per the route posted in the issue comment? Any logic bug, off-by-one, race, broken edge case, or behavioral regression to sibling code paths sharing the file? Did they reuse the existing pattern correctly?' },
  { key: 'security-pattern', focus: 'Security & pattern conformance: no new vuln (injection, path traversal, authz bypass, wire-leak of MediaItemRow), trust boundaries respected, follows resolveCallerRole/Zod/waitForExit conventions rather than inventing new ones, error codes consistent.' },
  { key: 'tests-gate', focus: 'Tests & gate integrity: are there fail-before/pass-after tests that genuinely exercise the fix (not trivial)? Re-run the gate yourself — does typecheck stay at baseline error count and do all tests pass? Reject if the gate is red or tests are missing/weak. For native clusters, verify the manual-verification steps are documented.' },
]

const results = []

for (const id of waveIds) {
  const c = REG[id]
  const branch = `fix/${id}`
  const issueList = c.issues.join(', ')

  phase('Implement')
  const impl = await agent(
    `${ctx}\n\nYou are the implementing developer for cluster '${id}'. Issues to fix IN THIS ORDER: ${issueList}.\n\nProcedure (run from ${root}):\n1. \`git fetch origin -q\` then create the branch fresh from the live integration tip: \`git checkout -B ${branch} origin/${INTEG}\`. (Cutting from origin/${INTEG} guarantees you include all previously-merged clusters — no stale base.)\n2. For EACH issue in order, run \`gh issue view <N> --comments\` and find the "🔬 Refinement & implementation route" comment — that is the AGREED route. Implement exactly that route. Read the cited files before editing. Add the fail-before/pass-after tests it specifies.\n3. Commit per issue: \`git commit -am "fix(#<N>): <short title>"\` (one commit per issue keeps the PR reviewable).\n4. GATE for this cluster: ${GATE_DESC[c.gate]}\n   If the gate cannot pass after honest effort, STILL push what you have but set gatePass=false and explain in gateNotes — do NOT fake green.\n5. \`git push -u origin ${branch}\`.\n6. Open a PR into ${INTEG}: \`gh pr create --base ${INTEG} --head ${branch} --title "fix(${id}): <summary>" --body "<body>"\`. The body MUST start with a line \`Closes #${c.issues.join(', closes #')}\` so merge auto-closes them, then a short per-issue summary of what changed and how it was verified, and a "Depends on" note if applicable.\n\nReturn the structured result (prNumber=0 if you could not open the PR). Be honest about gatePass.`,
    { label: `impl:${id}`, phase: 'Implement', schema: IMPL_SCHEMA }
  ).catch(e => ({ cluster: id, branch, issuesDone: [], gatePass: false, gateNotes: 'implement agent threw: ' + e, prNumber: 0, prUrl: '', summary: 'FAILED' }))

  if (!impl.prNumber) {
    log(`✗ ${id}: no PR opened (gate ${impl.gatePass}). Skipping review/merge.`)
    results.push({ cluster: id, status: 'no-pr', impl })
    continue
  }
  log(`${id}: PR #${impl.prNumber} opened (gate ${impl.gatePass ? 'green' : 'RED'}). Reviewing.`)

  // ---- review + revise loop ----
  let round = 0, approved = false, lastReviews = []
  while (round <= 2 && !approved) {
    phase('Review')
    const reviews = (await parallel(LENSES.map(L => () =>
      agent(`${ctx}\n\nYou are an adversarial REVIEWER (lens: ${L.key}) for PR #${impl.prNumber} (branch ${branch}, cluster ${id}, issues ${issueList}).\n\n1. \`git fetch origin -q && git diff origin/${INTEG}...origin/${branch}\` to see the full diff. Read changed files in full, not just the hunks.\n2. For each issue, \`gh issue view <N> --comments\` to confirm the implementation matches the agreed route.\n3. ${L.focus}\n4. Re-run the gate yourself if your lens is tests-gate.\n\nBe strict but fair — only raise BLOCKING items that genuinely must change before merge (real bugs, security holes, missing/weak tests, red gate). Style nits go in notes, not blockingItems. Return the structured verdict.`,
        { label: `review:${id}:${L.key}:r${round}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'Explore' })
        .catch(e => ({ lens: L.key, decision: 'request-changes', blockingItems: [{ issue: 0, file: '-', problem: 'reviewer threw: ' + e, requiredChange: 'rerun' }], notes: '' }))
    )))
    lastReviews = reviews
    const blocking = reviews.flatMap(r => (r.decision === 'request-changes' ? r.blockingItems : []))
    if (blocking.length === 0 && impl.gatePass) { approved = true; break }
    if (round === 2) { log(`✗ ${id}: still has ${blocking.length} blocking items after 2 revises — leaving PR open for human.`); break }

    round++
    phase('Implement')
    const rev = await agent(
      `${ctx}\n\nYou are the developer addressing review feedback on PR #${impl.prNumber} (branch ${branch}, cluster ${id}). Check out the branch: \`git fetch origin -q && git checkout ${branch} && git reset --hard origin/${branch}\`.\n\nBLOCKING ITEMS to fix:\n${JSON.stringify(blocking, null, 2)}\n\nFix every blocking item. Re-run the gate: ${GATE_DESC[c.gate]}. Commit (\`git commit -am "fix(${id}): address review round ${round}"\`) and \`git push\`. Return whether the gate passes now and what you addressed.`,
      { label: `revise:${id}:r${round}`, phase: 'Implement', schema: REVISE_SCHEMA }
    ).catch(e => ({ gatePass: false, addressed: [], summary: 'revise threw: ' + e }))
    impl.gatePass = rev.gatePass
  }

  phase('Merge')
  if (approved) {
    const merge = await agent(
      `${ctx}\n\nMerge PR #${impl.prNumber} (branch ${branch}) into ${INTEG}. All ${LENSES.length} reviewers approved and the gate is green. Run: \`gh pr merge ${impl.prNumber} --squash --delete-branch\`. If it reports a merge conflict or non-fast-forward, do NOT force; instead \`git fetch origin\`, rebase the branch onto origin/${INTEG}, resolve conflicts, re-run the gate (${GATE_DESC[c.gate]}), push, and retry the merge once. Then \`git fetch origin\` and return the new ${INTEG} tip sha (\`git rev-parse --short origin/${INTEG}\`). Report merged=false with notes if it could not be merged cleanly.`,
      { label: `merge:${id}`, phase: 'Merge', schema: MERGE_SCHEMA }
    ).catch(e => ({ merged: false, sha: '', notes: 'merge threw: ' + e }))
    log(merge.merged ? `✓ ${id}: merged into ${INTEG} @ ${merge.sha}` : `✗ ${id}: merge failed — ${merge.notes}`)
    results.push({ cluster: id, status: merge.merged ? 'merged' : 'merge-failed', prNumber: impl.prNumber, prUrl: impl.prUrl, issues: c.issues, merge, reviewNotes: lastReviews.map(r => ({ lens: r.lens, decision: r.decision })) })
  } else {
    results.push({ cluster: id, status: 'needs-human', prNumber: impl.prNumber, prUrl: impl.prUrl, issues: c.issues, gatePass: impl.gatePass, blocking: lastReviews.flatMap(r => r.blockingItems || []) })
  }
}

return { wave: waveIds, results }
