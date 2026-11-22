/* Chrononaut Question Engine
 * Mechanics are data-agnostic. Content facts remain in data.js; constraints only
 * use explicitly supplied answer metadata and never infer historical facts.
 */
(function (global) {
  'use strict';

  const TIERS = Object.freeze(['Common', 'Uncommon', 'Rare', 'Paradox']);
  const TIER_SCORE = Object.freeze({ Common: 1, Uncommon: 2, Rare: 3, Paradox: 4 });
  const RARITY_MODES = Object.freeze({
    mainstream: { label: 'Mainstream', tiers: ['Common', 'Uncommon'] },
    balanced: { label: 'Balanced', tiers: TIERS },
    niche: { label: 'Niche', tiers: ['Rare', 'Paradox'] }
  });

  const WILDCARDS = Object.freeze([
    { type: 'speed-run', label: 'Speed Run · 15 seconds', description: 'The clock is shortened to 15 seconds.', duration: 15 },
    { type: 'inverse-rarity', label: 'Inverse Rarity', description: 'Accessible answers are worth more fuel than obscure ones.' },
    { type: 'double-or-nothing', label: 'Double or Nothing', description: 'A correct answer doubles the accumulated fuel; a miss forfeits it.' }
  ]);

  const DEFAULTS = Object.freeze({
    runCount: 2,
    jumpsPerRun: 7,
    domainMixing: true,
    rarity: 'balanced',
    wildcard: true,
    baseDuration: 25,
    minAnswersForConstraint: 3,
    seed: 20261122
  });

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < String(value).length; i++) {
      hash ^= String(value).charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let state = (Number(seed) >>> 0) || 1;
    return function random() {
      state += 0x6D2B79F5;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(items, random) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function pick(items, random) {
    return items.length ? items[Math.floor(random() * items.length)] : null;
  }

  function normalizeTokens(value) {
    return String(value ?? '').toLocaleLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim();
  }

  function includesEntity(values, expected) {
    const target = normalizeTokens(expected);
    if (!target) return false;
    const list = Array.isArray(values) ? values : [values];
    return list.some(value => {
      const candidate = normalizeTokens(value);
      return candidate === target || (` ${candidate} `).includes(` ${target} `);
    });
  }

  const CONSTRAINTS = Object.freeze({
    temporal: {
      prompt: rule => `Name a ${rule.subject || 'entry'} dated ${rule.direction === 'after' ? 'after' : 'before'} ${rule.year}.`,
      accepts: (answer, rule) => {
        const year = Number(answer.metadata?.temporalYear);
        if (!Number.isFinite(year) || !Number.isFinite(Number(rule.year))) return false;
        return rule.direction === 'after' ? year > Number(rule.year) : year < Number(rule.year);
      }
    },
    origin: {
      prompt: rule => `Name a ${rule.subject || 'entry'} originating in ${rule.origin}${rule.before ? ` before ${rule.before}` : ''}.`,
      accepts: (answer, rule) => {
        const originMatches = includesEntity(answer.metadata?.origin, rule.origin);
        if (!originMatches) return false;
        if (!rule.before) return true;
        const year = Number(answer.metadata?.temporalYear);
        return Number.isFinite(year) && year < Number(rule.before);
      }
    },
    associative: {
      prompt: rule => `Name a ${rule.subject || 'entry'} that ${rule.relation || 'is associated with'} ${rule.person}${rule.period ? ` ${rule.period}` : ''}.`,
      accepts: (answer, rule) => includesEntity(answer.metadata?.associations, rule.person)
    }
  });

  function flattenPools(collections) {
    const pools = [];
    (Array.isArray(collections) ? collections : []).forEach((collection, collectionIndex) => {
      (Array.isArray(collection?.rounds) ? collection.rounds : []).forEach((pool, poolIndex) => {
        if (!pool || !Array.isArray(pool.answers) || !pool.answers.length) return;
        pools.push({
          ...pool,
          id: pool.id || `${collection.id || `collection-${collectionIndex + 1}`}-pool-${poolIndex + 1}`,
          era: pool.era || pool.domain || collection.id || `Domain ${collectionIndex + 1}`,
          domain: pool.domain || pool.era || collection.id || `Domain ${collectionIndex + 1}`,
          sourceCollection: collection.id || `collection-${collectionIndex + 1}`
        });
      });
    });
    return pools;
  }

  function validatePool(pool) {
    const errors = [];
    if (!pool.prompt && !pool.template) errors.push('missing prompt/template');
    if (!Array.isArray(pool.answers) || pool.answers.length === 0) errors.push('no answers');
    const seen = new Set();
    (pool.answers || []).forEach((answer, index) => {
      if (!answer?.name) errors.push(`answer ${index + 1}: missing name`);
      const key = normalizeTokens(answer?.name);
      if (key && seen.has(key)) errors.push(`duplicate answer name: ${answer.name}`);
      if (key) seen.add(key);
      if (!Number.isFinite(Number(answer?.points)) || Number(answer.points) < 0) errors.push(`answer ${answer?.name || index + 1}: invalid points`);
      if (!TIERS.includes(answer?.tier)) errors.push(`answer ${answer?.name || index + 1}: unknown tier`);
    });
    return errors;
  }

  function eligibleAnswers(pool, rarityMode) {
    const mode = RARITY_MODES[rarityMode] || RARITY_MODES.balanced;
    return pool.answers.filter(answer => mode.tiers.includes(answer.tier));
  }

  function constraintParts(variant) {
    if (Array.isArray(variant.allOf) && variant.allOf.length) return { mode: 'all', parts: variant.allOf };
    if (Array.isArray(variant.anyOf) && variant.anyOf.length) return { mode: 'any', parts: variant.anyOf };
    return { mode: 'single', parts: [variant] };
  }

  function acceptsConstraint(answer, variant) {
    const { mode, parts } = constraintParts(variant);
    const checks = parts.map(part => {
      const rule = CONSTRAINTS[part.type];
      return !!rule && rule.accepts(answer, part);
    });
    return mode === 'all' ? checks.every(Boolean) : mode === 'any' ? checks.some(Boolean) : checks[0];
  }

  function constraintPrompt(variant) {
    if (variant.prompt) return variant.prompt;
    const { mode, parts } = constraintParts(variant);
    if (mode === 'single') return CONSTRAINTS[parts[0].type].prompt({ ...variant, ...parts[0] });
    const clauses = parts.map(part => {
      const subject = part.subject || variant.subject || 'entry';
      const prompt = CONSTRAINTS[part.type].prompt({ ...variant, ...part });
      const prefix = `Name a ${subject} `;
      return (prompt.startsWith(prefix) ? prompt.slice(prefix.length) : prompt).replace(/[.]$/, '');
    });
    const conjunction = mode === 'all' ? ' and ' : ' or ';
    return `Name a ${variant.subject || 'entry'} ${clauses.join(conjunction)}.`;
  }

  function chooseConstraint(pool, random, minAnswers) {
    const variants = Array.isArray(pool.constraintVariants) ? pool.constraintVariants : [];
    const viable = variants.map(variant => {
      const { parts } = constraintParts(variant);
      if (!parts.length || parts.some(part => !CONSTRAINTS[part.type])) return null;
      const answers = pool.answers.filter(answer => acceptsConstraint(answer, variant));
      return answers.length >= minAnswers ? { variant, answers } : null;
    }).filter(Boolean);
    return pick(viable, random);
  }

  function buildQuestion(pool, options, random) {
    const question = {
      ...pool,
      answers: pool.answers.map(answer => ({
        ...answer,
        aliases: Array.isArray(answer.aliases) ? answer.aliases.slice() : [],
        metadata: answer.metadata ? { ...answer.metadata } : undefined
      }))
    };

    const rarityEligible = eligibleAnswers(question, options.rarity);
    question.answers = rarityEligible;

    // Constraints operate only on the active rarity slice.
    const constraint = chooseConstraint(question, random, options.minAnswersForConstraint);
    if (constraint) {
      question.answers = constraint.answers;
      question.prompt = constraintPrompt(constraint.variant);
      question.constraint = constraint.variant.label || constraint.variant.type || 'combined';
      question.constraintType = Array.isArray(constraint.variant.allOf) || Array.isArray(constraint.variant.anyOf)
        ? 'combined' : constraint.variant.type;
    } else if (typeof pool.template === 'function') {
      question.prompt = pool.template(pool);
    } else if (typeof pool.template === 'string') {
      question.prompt = pool.template.replace(/\{\{(subject|domain|era|constraint)\}\}/g, (_, key) => pool[key] || '');
    }

    question.rarityMode = options.rarity;
    question.duration = Number(pool.duration) > 0 ? Number(pool.duration) : options.baseDuration;
    question.hint = question.hint || 'Explore the archive for a valid answer.';
    question.constraint = question.constraint || pool.constraint || 'Open archive';
    return question;
  }

  function selectPools(allPools, options, random) {
    const rarity = options.rarity;
    const candidates = allPools.filter(pool => eligibleAnswers(pool, rarity).length > 0);
    const shuffled = shuffle(candidates, random);
    const selected = [];
    const domainCounts = new Map();
    const collectionCounts = new Map();

    while (selected.length < options.jumpsPerRun && shuffled.length) {
      let bestScore = -Infinity;
      let bestIndices = [];
      shuffled.forEach((pool, index) => {
        if (selected.includes(pool)) return;
        const domainCount = domainCounts.get(pool.domain) || 0;
        const collectionCount = collectionCounts.get(pool.sourceCollection) || 0;
        const score = (options.domainMixing ? -domainCount * 100 : 0) - collectionCount * 4 + random();
        if (score > bestScore + 1e-9) { bestScore = score; bestIndices = [index]; }
        else if (Math.abs(score - bestScore) <= 1e-9) bestIndices.push(index);
      });
      if (!bestIndices.length) break;
      const chosenIndex = pick(bestIndices, random);
      const chosen = shuffled[chosenIndex];
      selected.push(chosen);
      domainCounts.set(chosen.domain, (domainCounts.get(chosen.domain) || 0) + 1);
      collectionCounts.set(chosen.sourceCollection, (collectionCounts.get(chosen.sourceCollection) || 0) + 1);
      shuffled.splice(chosenIndex, 1);
    }
    return selected;
  }

  function calculateFuel(answer, roundData) {
    if (!answer) return 0;
    let fuel = Math.max(0, Number(answer.points) || 0);
    if (roundData?.modifier?.type === 'inverse-rarity') {
      fuel = Math.max(15, 115 - fuel);
    }
    if (roundData?.rarityMode === 'mainstream') {
      fuel = Math.min(60, Math.round(15 + (fuel - 15) * 0.53));
    }
    return Math.max(0, Math.round(fuel));
  }

  function createRuns(content, suppliedOptions = {}) {
    const options = { ...DEFAULTS, ...suppliedOptions };
    options.runCount = Math.max(1, Math.floor(Number(options.runCount) || DEFAULTS.runCount));
    options.jumpsPerRun = Math.max(1, Math.floor(Number(options.jumpsPerRun) || DEFAULTS.jumpsPerRun));
    options.baseDuration = Math.max(1, Number(options.baseDuration) || DEFAULTS.baseDuration);
    options.minAnswersForConstraint = Math.max(1, Math.floor(Number(options.minAnswersForConstraint) || DEFAULTS.minAnswersForConstraint));
    if (!RARITY_MODES[options.rarity]) options.rarity = 'balanced';

    const allPools = flattenPools(content);
    const diagnostics = allPools.flatMap(pool => validatePool(pool).map(message => `${pool.id}: ${message}`));
    if (!allPools.length) return [];

    return Array.from({ length: options.runCount }, (_, runIndex) => {
      const random = seededRandom((Number(options.seed) + hashString(allPools.map(pool => pool.id).join('|')) + runIndex * 104729) >>> 0);
      const selected = selectPools(allPools, options, random);
      const rounds = selected.map(pool => buildQuestion(pool, options, random));
      const wildcard = options.wildcard ? pick(WILDCARDS, random) : null;
      const wildcardIndex = wildcard && rounds.length ? Math.floor(random() * rounds.length) : -1;
      if (wildcardIndex >= 0) {
        rounds[wildcardIndex].modifier = wildcard;
        if (wildcard.duration) rounds[wildcardIndex].duration = wildcard.duration;
      }
      rounds.forEach(round => {
        if (round.rarityMode === 'mainstream') round.hint = `${round.hint} Mainstream run: accessible entries are in focus.`;
        if (round.rarityMode === 'niche') round.hint = `${round.hint} Niche run: seek specialist-level entries.`;
      });
      return {
        id: `EXPEDITION #${String(runIndex + 1).padStart(2, '0')}`,
        rounds,
        settings: { rarity: options.rarity, domainMixing: !!options.domainMixing, wildcard: !!wildcard },
        diagnostics: runIndex === 0 ? diagnostics : []
      };
    });
  }

  global.QuestionEngine = Object.freeze({
    createRuns,
    calculateFuel,
    validatePool,
    rules: Object.freeze({ constraints: CONSTRAINTS, rarity: RARITY_MODES }),
    wildcards: WILDCARDS
  });
})(window);
