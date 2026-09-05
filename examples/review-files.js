export const meta = {
  name: 'review-files',
  description: 'Review the files passed via args for bugs, then adversarially verify each finding',
  phases: [
    { title: 'Review', detail: 'one reviewer per file' },
    { title: 'Verify', detail: 'one skeptic per finding' },
  ],
}

// usage: understudy run examples/review-files.js --args '{"files":["src/a.js","src/b.js"]}'
const FILES = (args && args.files) || []
if (!FILES.length) return { error: 'pass --args {"files": [...]} — nothing to review' }

const FINDINGS = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          summary: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['summary', 'severity'],
      },
    },
  },
  required: ['file', 'findings'],
}

const VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['real'],
}

const reviewed = await pipeline(
  FILES,
  (file) => agent(
    `Read the file ${file} with the Read tool and report correctness bugs only (no style nits). ` +
    'Cite line numbers from the numbered output. If the file is clean, return an empty findings list.',
    { label: `review:${file}`, phase: 'Review', schema: FINDINGS },
  ),
  (rev) => rev && rev.findings.length
    ? parallel(rev.findings.map((f) => () =>
      agent(
        `Adversarially verify this claimed bug in ${rev.file}: "${f.summary}" (line ${f.line ?? '?'}). ` +
        'Re-read the file yourself with the Read tool. Default to real=false if you cannot reproduce the reasoning.',
        { label: `verify:${rev.file}:${f.line ?? '?'}`, phase: 'Verify', schema: VERDICT },
      ).then((v) => ({ ...f, file: rev.file, confirmed: !!(v && v.real), reason: v && v.reason }))))
    : [],
)

const flat = reviewed.filter(Boolean).flat()
const confirmed = flat.filter((f) => f.confirmed)
log(`findings: ${flat.length}, confirmed: ${confirmed.length}`)
return { files: FILES.length, findings: flat, confirmed }
