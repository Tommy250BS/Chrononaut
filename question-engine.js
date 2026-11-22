/* Question Engine: mechanics and variation are independent from subject-matter pools. */
(function (global) {
  const WILDCARDS = [
    { type: 'speed-run', label: 'Speed Run · 15 seconds', description: 'The clock is shortened to 15 seconds.', duration: 15 },
    { type: 'inverse-rarity', label: 'Inverse Rarity', description: 'Common answers are worth more than obscure answers.' },
    { type: 'double-or-nothing', label: 'Double or Nothing', description: 'A correct answer doubles its fuel; a miss forfeits accumulated fuel.' }
  ];

  const CONSTRAINT_RULES = {
    temporal: {
      prompt: ({ subject, direction = 'before', year }) => `Name a ${subject} ${direction} ${year}.`,
      accepts: (answer, rule) => {
        const value = Number(answer.metadata?.temporalYear);
        if (!Number.isFinite(value)) return false;
        return rule.direction === 'after' ? value > rule.year : value < rule.year;
      }
    },
    origin: {
      prompt: ({ subject, origin, before }) => `Name a ${subject} originating in ${origin}${before ? ` before ${before}` : ''}.`,
      accepts: (answer, rule) => {
        const value = String(answer.metadata?.origin || '').toLowerCase();
        return value.includes(String(rule.origin).toLowerCase()) && (!rule.before || Number(answer.metadata?.temporalYear) < rule.before);
      }
    },
    associative: {
      prompt: ({ subject, relation, person, period }) => `Name a ${subject} that ${relation} ${person}${period ? ` ${period}` : ''}.`,
      accepts: (answer, rule) => (answer.metadata?.associations || []).some(value => String(value).toLowerCase().includes(String(rule.person).toLowerCase()))
    }
  };

  const RULES = {
    templates: {
      // A pool may supply a custom template; otherwise its editorial prompt remains the fallback.
      default: ({ prompt }) => prompt
    },
    constraints: CONSTRAINT_RULES,
    rarity: {
      mainstream: { label: 'Mainstream', score: 'compressed' },
      balanced: { label: 'Balanced', score: 'native' },
      niche: { label: 'Niche', score: 'native' }
    }
  };

  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function shuffle(items, random) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function buildQuestion(pool, rules, random) {
    const question = {
      ...pool,
      prompt: (pool.template || rules.templates.default)(pool),
      answers: pool.answers.map(answer => ({ ...answer, aliases: [...(answer.aliases || [])] }))
    };
    // Constraint variants are opt-in: answer metadata is required, so the engine never guesses facts.
    if (Array.isArray(pool.constraintVariants) && pool.constraintVariants.length) {
      const variant = pool.constraintVariants[Math.floor(random() * pool.constraintVariants.length)];
      const rule = rules.constraints[variant.type];
      if (rule) {
        const eligible = question.answers.filter(answer => rule.accepts(answer, variant));
        if (eligible.length) {
          question.answers = eligible;
          question.prompt = rule.prompt({ ...variant, subject: variant.subject || pool.subject || 'entry' });
          question.constraint = variant.label || variant.type;
        }
      }
    }
    return question;
  }

  function createRuns(contentSeeds, options = {}) {
    const runCount = options.runCount ?? contentSeeds.length;
    const jumps = options.jumpsPerRun ?? 7;
    const runs = [];

    for (let runIndex = 0; runIndex < runCount; runIndex++) {
      const source = contentSeeds[runIndex % contentSeeds.length];
      const random = seededRandom((runIndex + 1) * 7919 + source.id.length * 31);
      let pools = [...source.rounds];
      if (options.domainMixing) pools = shuffle(pools, random);
      pools = pools.slice(0, jumps);

      const rarityMode = options.rarity || 'balanced';
      const wildcardIndex = options.wildcard ? Math.floor(random() * pools.length) : -1;
      const wildcard = wildcardIndex >= 0 ? WILDCARDS[Math.floor(random() * WILDCARDS.length)] : null;

      const rounds = pools.map((pool, index) => {
        const question = buildQuestion(pool, RULES, random);
        const rarityPool = rarityMode === 'mainstream'
          ? question.answers.filter(answer => ['Common', 'Uncommon'].includes(answer.tier))
          : rarityMode === 'niche'
            ? question.answers.filter(answer => ['Rare', 'Paradox'].includes(answer.tier))
            : question.answers;
        question.answers = rarityPool.length ? rarityPool : question.answers;
        question.rarityMode = rarityMode;
        question.duration = 25;
        if (index === wildcardIndex && wildcard) {
          question.modifier = wildcard;
          if (wildcard.duration) question.duration = wildcard.duration;
        }
        if (rarityMode === 'mainstream') question.hint = `${question.hint} Mainstream scoring favors accessible answers.`;
        if (rarityMode === 'niche') question.hint = `${question.hint} Niche run: seek specialist-level entries.`;
        return question;
      });

      runs.push({ id: source.id, rounds, settings: { rarity: rarityMode, domainMixing: !!options.domainMixing } });
    }
    return runs;
  }

  global.QuestionEngine = Object.freeze({ createRuns, rules: RULES, wildcards: WILDCARDS });
})(window);
