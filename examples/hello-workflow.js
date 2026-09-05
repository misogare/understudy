export const meta = {
  name: 'hello-understudy',
  description: 'Smoke-test workflow: 3-lane pipeline with structured output and a verify phase',
  phases: [
    { title: 'Describe', detail: 'one agent per topic' },
    { title: 'Verify', detail: 'adversarial check per description' },
  ],
}

const TOPICS = (args && args.topics) || ['journal.jsonl', 'pipeline()', 'structured output']

const DESC = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    summary: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['topic', 'summary', 'confidence'],
}

const VERDICT = {
  type: 'object',
  properties: { plausible: { type: 'boolean' }, note: { type: 'string' } },
  required: ['plausible'],
}

const results = await pipeline(
  TOPICS,
  (topic, _t, i) => agent(
    `In two sentences, explain what "${topic}" means in the context of an agent workflow runner.`,
    { label: `describe:${i}`, phase: 'Describe', schema: DESC },
  ),
  (desc, topic) => desc
    ? agent(
      `Is this explanation of "${topic}" plausible and non-empty? ${JSON.stringify(desc)}`,
      { label: `verify:${topic}`, phase: 'Verify', schema: VERDICT },
    ).then((v) => ({ ...desc, verified: !!(v && v.plausible) }))
    : null,
)

log(`described ${results.filter(Boolean).length}/${TOPICS.length} topics`)
return { topics: TOPICS.length, results: results.filter(Boolean) }
