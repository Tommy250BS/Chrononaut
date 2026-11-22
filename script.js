let gameData = null;
let currentExpedition = [];
let currentJumpIndex = 0;
let totalFuel = 0;
let currentYear = 2026;
let roundAnswersLog = [];
let timerInterval = null;
let timeLeft = 25;
let frozen = false;

async function init() {
  try {
    const res = await fetch('questions.json');
    gameData = await res.json();
    startExpedition();
  } catch (err) {
    console.error("Failed to load questions.json:", err);
    document.getElementById('app').innerHTML = `
      <div class="panel">
        <h3>System Fault</h3>
        <p>Could not load chronological database (` + err.message + `). Make sure you are serving via a local web server (like Live Server or http-server).</p>
      </div>
    `;
  }
}

function getDailySeed() {
  const dateStr = new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = (hash * 31 + dateStr.charCodeAt(i)) % 100000;
  }
  return hash;
}

function startExpedition() {
  const seed = getDailySeed();
  const categories = Object.keys(gameData.categories);
  currentExpedition = [];
  currentJumpIndex = 0;
  totalFuel = 0;
  currentYear = 2026;
  roundAnswersLog = [];

  // Pick 7 distinct categories pseudorandomly using the seed
  for (let i = 0; i < 7; i++) {
    const catKey = categories[(seed + i * 13) % categories.length];
    const catObj = gameData.categories[catKey];
    const template = gameData.templates[(seed + i * 7) % gameData.templates.length];
    
    // Format prompt formula
    let promptText = template.formula
      .replace('{domain}', catObj.domain)
      .replace('{era}', catKey);

    currentExpedition.push({
      jumpNumber: i + 1,
      era: catKey,
      prompt: promptText,
      entries: catObj.entries
    });
  }

  renderJump();
}

function renderJump() {
  if (currentJumpIndex >= currentExpedition.length) {
    renderDebrief();
    return;
  }

  const jump = currentExpedition[currentJumpIndex];
  timeLeft = 25;
  frozen = false;
  clearInterval(timerInterval);

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="panel">
      <div class="telemetry-grid">
        <div class="telemetry-item">
          <label>Jump Sequence</label>
          <div class="value">0${jump.jumpNumber} / 07</div>
        </div>
        <div class="telemetry-item">
          <label>Destination Year</label>
          <div class="value" id="year-display">${currentYear} AD</div>
        </div>
        <div class="telemetry-item">
          <label>Chronal Fuel</label>
          <div class="value" id="fuel-display">+${totalFuel} yrs</div>
        </div>
      </div>

      <div class="fuel-meter-container">
        <span>BOILER PRESSURE</span>
        <div class="fuel-track">
          <div class="fuel-fill" id="fuel-bar" style="width: ${(totalFuel / 500) * 100}%"></div>
        </div>
        <span id="timer-display">⏱ 25s</span>
      </div>

      <div class="prompt-box">
        <h3>Sector: ${jump.era}</h3>
        <h2>${jump.prompt}</h2>
      </div>

      <form id="answer-form" class="input-group">
        <input type="text" id="user-input" placeholder="Type your answer..." autocomplete="off" autofocus />
        <button type="submit">Lock In</button>
      </form>
      
      <div id="feedback-area"></div>
    </div>
  `;

  document.getElementById('answer-form').addEventListener('submit', handleSubmission);

  timerInterval = setInterval(() => {
    if (!frozen) {
      timeLeft--;
      const timerEl = document.getElementById('timer-display');
      if (timerEl) timerEl.textContent = `⏱ ${timeLeft}s`;
      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        submitAnswer(null); // Time out
      }
    }
  }, 1000);
}

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
      }
    }
  }
  return matrix[b.length][a.length];
}

function handleSubmission(e) {
  e.preventDefault();
  const inputEl = document.getElementById('user-input');
  const val = inputEl.value.trim();
  submitAnswer(val);
}

function submitAnswer(rawInput) {
  clearInterval(timerInterval);
  frozen = true;
  const jump = currentExpedition[currentJumpIndex];
  
  let matchedEntry = null;
  let pointsEarned = 0;
  let statusText = "TIME EXPIRED — NO FUEL GENERATED";
  let tierClass = "badge-common";

  if (rawInput) {
    const cleanInput = rawInput.toLowerCase();
    for (let entry of jump.entries) {
      const names = [entry.name.toLowerCase(), ...(entry.aliases || [])];
      for (let n of names) {
        if (cleanInput === n || (n.length > 4 && levenshtein(cleanInput, n) <= 2)) {
          matchedEntry = entry;
          break;
        }
      }
      if (matchedEntry) break;
    }

    if (matchedEntry) {
      pointsEarned = matchedEntry.points;
      totalFuel += pointsEarned;
      currentYear += pointsEarned;

      if (pointsEarned >= 80) {
        tierClass = "badge-paradox";
        statusText = `PARADOX DISCOVERY! +${pointsEarned} YRS`;
      } else if (pointsEarned >= 50) {
        tierClass = "badge-rare";
        statusText = `RARE ANOMALY! +${pointsEarned} YRS`;
      } else if (pointsEarned >= 30) {
        tierClass = "badge-uncommon";
        statusText = `UNCOMMON MATCH +${pointsEarned} YRS`;
      } else {
        tierClass = "badge-common";
        statusText = `COMMON ENTRY +${pointsEarned} YRS`;
      }
    } else {
      statusText = `UNRECOGNIZED TIMELINE ANCHOR ("${rawInput}") — 0 YRS`;
    }
  }

  roundAnswersLog.push({
    jump: jump.jumpNumber,
    era: jump.era,
    prompt: jump.prompt,
    input: rawInput || "Timed Out",
    matched: matchedEntry ? matchedEntry.name : null,
    points: pointsEarned
  });

  // Render Feedback
  const feedbackArea = document.getElementById('feedback-area');
  feedbackArea.innerHTML = `
    <div class="feedback-box">
      <div class="badge-rarity ${tierClass}">${statusText}</div>
      <p style="font-size: 0.9rem; margin-bottom: 1rem;">${matchedEntry ? `Matched: <strong>${matchedEntry.name}</strong>` : 'No valid entry recognized in database.'}</p>
      <button id="next-jump-btn">Proceed to Next Jump &rarr;</button>
    </div>
  `;

  document.getElementById('next-jump-btn').addEventListener('click', () => {
    currentJumpIndex++;
    renderJump();
  });
}

function renderDebrief() {
  const app = document.getElementById('app');
  let rowsHtml = roundAnswersLog.map(r => `
    <div class="receipt-row">
      <span>Jump 0${r.jump} (${r.era})</span>
      <span><strong>${r.matched || 'Missed'}</strong> (+${r.points} yrs)</span>
    </div>
  `).join('');

  app.innerHTML = `
    <div class="panel">
      <div class="receipt-header">
        <h3>EXPEDITION LOG COMPLETE</h3>
        <h2>Destination Reached: ${currentYear} AD</h2>
        <p style="font-family:'IBM Plex Mono'; font-size:0.85rem; margin-top:0.5rem;">Total Chronal Fuel Burned: +${totalFuel} Years</p>
      </div>

      <div class="receipt-rows">
        ${rowsHtml}
      </div>

      <button id="restart-btn" class="secondary" style="width:100%; margin-top: 1rem;">Launch New Expedition</button>
    </div>
  `;

  document.getElementById('restart-btn').addEventListener('click', startExpedition);
}

window.addEventListener('DOMContentLoaded', init);
