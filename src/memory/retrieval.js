const { cosineSimilarity, estimateTokens, hashedEmbedding } = require("./contentAddressing");

const TIER_WEIGHTS = Object.freeze({ SHORT: 0.12, EPISODIC: 0.08, LONG: 0.04 });

function normalizedLexicalScore(value) {
  const score = Math.max(0, Number(value) || 0);
  return score / (1 + score);
}

function recencyScore(value, now = Date.now()) {
  const created = new Date(value).getTime();
  if (!Number.isFinite(created)) return 0;
  const ageDays = Math.max(0, (now - created) / 86_400_000);
  return 1 / (1 + (ageDays / 30));
}

function rerankCandidates(query, candidates, { now = Date.now() } = {}) {
  const queryEmbedding = hashedEmbedding(query);
  return candidates.map((candidate) => {
    const semantic = Math.max(0, cosineSimilarity(queryEmbedding, candidate.embedding_json || candidate.embedding || []));
    const lexical = normalizedLexicalScore(candidate.lexical_score);
    const recency = recencyScore(candidate.created_at, now);
    const score = (lexical * 0.45) + (semantic * 0.40) + (recency * 0.10)
      + (TIER_WEIGHTS[candidate.tier] || 0);
    return {
      ...candidate,
      lexicalScore: Number(lexical.toFixed(8)),
      semanticScore: Number(semantic.toFixed(8)),
      recencyScore: Number(recency.toFixed(8)),
      score: Number(score.toFixed(8)),
    };
  }).sort((left, right) => (
    right.score - left.score
    || String(left.source_id).localeCompare(String(right.source_id))
    || Number(left.source_version) - Number(right.source_version)
    || Number(left.ordinal) - Number(right.ordinal)
  ));
}

function selectWithinBudget(candidates, { tokenBudget, selectedLimit }) {
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1) throw new Error("tokenBudget must be positive");
  if (!Number.isInteger(selectedLimit) || selectedLimit < 1) throw new Error("selectedLimit must be positive");
  const selected = [];
  let tokenCount = 0;
  for (const candidate of candidates) {
    if (selected.length >= selectedLimit) break;
    const candidateTokens = Number(candidate.token_count) || estimateTokens(candidate.content_text || candidate.content || "");
    if (candidateTokens <= 0 || candidateTokens > tokenBudget - tokenCount) continue;
    selected.push(candidate);
    tokenCount += candidateTokens;
  }
  return { selected, tokenCount, truncated: selected.length < candidates.length };
}

class RetrievalLimiter {
  constructor({ concurrency = 2, queueLimit = 8 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("retrieval concurrency must be positive");
    if (!Number.isInteger(queueLimit) || queueLimit < 0) throw new Error("retrieval queueLimit cannot be negative");
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
    this.active = 0;
    this.queue = [];
  }

  async run(operation) {
    if (typeof operation !== "function") throw new Error("retrieval operation must be a function");
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.queueLimit) {
        const error = new Error("memory retrieval backpressure limit reached");
        error.code = "MEMORY_BACKPRESSURE";
        throw error;
      }
      await new Promise((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

module.exports = {
  RetrievalLimiter,
  normalizedLexicalScore,
  recencyScore,
  rerankCandidates,
  selectWithinBudget,
};
