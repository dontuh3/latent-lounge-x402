const $ = id => document.getElementById(id);
function node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  let data; try { data = await response.json(); } catch { throw new Error('The lounge returned an unreadable response. Please try later.'); }
  if (!response.ok) throw new Error(`${data.error || `HTTP ${response.status}`}${response.status === 429 ? ` Retry after ${response.headers.get('Retry-After') || 'a few'} seconds.` : ''}`);
  return data;
}

if (["localhost", "127.0.0.1"].includes(location.hostname)) { const notice=node("div","LOCAL PREVIEW · ISOLATED TEST DATA","preview-notice"); document.body.prepend(notice); }
let sample = null, busy = false;
let deadline = 0;
function progress(step) {
  document.querySelectorAll('.sample-progress li').forEach((item, index) => {
    if (index === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    item.classList.toggle('complete', index < step);
  });
}
function clock() {
  if (!$('sample-clock')) return;
  const seconds = sample ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;
  $('sample-clock').textContent = sample ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} LEFT` : '';
  if (sample && seconds === 0 && !busy) {
    sample = null; $('answer-form').hidden = true;
    $('sample-status').textContent = 'Time is up. Generate another free puzzle to try again.';
    progress(0);
  }
}
if ($('sample-clock')) setInterval(clock, 1000);
function setBusy(value) { busy = value; for (const id of ['load-puzzle','submit-answer','game']) if ($(id)) $(id).disabled = value; document.querySelectorAll('[data-start]').forEach(e => { if (e.tagName === 'BUTTON') e.disabled = value; }); }
function renderValue(parent, key, value) {
  if (key) parent.append(node('h4', key.replace(/([a-z])([A-Z])/g, '$1 $2')));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const group = node('dl', undefined, 'value-grid');
    for (const [label, item] of Object.entries(value)) {
      const cell = node('div'); cell.append(node('dt', label));
      const description = node('dd');
      if (item && typeof item === 'object') renderValue(description, '', item);
      else description.textContent = String(item);
      cell.append(description); group.append(cell);
    }
    parent.append(group); return;
  }
  if (Array.isArray(value)) {
    const list = node(key === 'program' || key === 'clues' ? 'ol' : 'ul', undefined, key === 'program' ? 'program-list' : ['codenames','drinks','games'].includes(key) ? 'attribute-list' : 'puzzle-list');
    value.forEach(v => { const item = node('li'); if (v && typeof v === 'object') renderValue(item, '', v); else item.textContent = String(v); list.append(item); }); parent.append(list);
  } else parent.append(node(typeof value === 'object' ? 'pre' : 'p', typeof value === 'object' ? JSON.stringify(value, null, 2) : value));
}
async function loadPuzzle(game = $('game').value) {
  if (busy) return;
  setBusy(true); sample = null; $('game').value = game; $('answer-form').hidden = true; $('feedback').hidden = true;
  progress(0); clock(); $('puzzle-title').textContent = 'PREPARING YOUR TABLE';
  $('sample-status').classList.remove('error'); $('sample-status').textContent = 'The house is preparing your puzzle…';
  $('puzzle-content').replaceChildren();
  try {
    sample = await request(`/api/sample/${encodeURIComponent(game)}`);
    deadline = Date.now() + sample.ttlSeconds * 1000; progress(1); clock();
    $('puzzle-title').textContent = $('game').selectedOptions[0].textContent;
    const content = $('puzzle-content');
    content.append(node('p', sample.instructions, 'puzzle-instructions'));
    if (typeof sample.prompt === 'object') Object.entries(sample.prompt).forEach(([k,v]) => renderValue(content,k,v));
    else if (game === 'walk') {
      content.append(node('h4', 'Your route · start at 0,0 facing north'));
      const route = node('ol', undefined, 'command-route');
      sample.prompt.split(/\s+/).forEach(command => route.append(node('li', command)));
      content.append(route);
    }
    else renderValue(content,'Puzzle',sample.prompt);
    if (sample.inputs) renderValue(content,'Inputs',sample.inputs);
    if (sample.layers) renderValue(content,'Layers',sample.layers);
    $('sample-status').textContent = 'Free sample · Standard difficulty · One attempt · No standings affected';
    $('guess').value = ''; $('guess').disabled = false; $('answer-form').hidden = false; $('guess').focus({ preventScroll: true });
  } catch(error) { sample = null; clock(); progress(0); $('puzzle-title').textContent = 'PLEASE TRY AGAIN'; $('sample-status').textContent = error.message; $('sample-status').classList.add('error'); }
  finally { setBusy(false); }
}
if ($('load-puzzle')) {
  const selected = new URLSearchParams(location.search).get('game');
  if ([...$('game').options].some(option => option.value === selected)) $('game').value = selected;
  $('load-puzzle').addEventListener('click', () => loadPuzzle());
  document.querySelectorAll('[data-start]').forEach(button => button.addEventListener('click', e => { e.preventDefault(); if (busy) return; $('try').scrollIntoView(); loadPuzzle(button.dataset.start); }));
  $('game').addEventListener('change', () => { if (sample) $('sample-status').textContent = 'Generate the selected game to replace your current free puzzle. Your current answer still applies to the displayed puzzle.'; });
  $('answer-form').addEventListener('submit', async e => {
    e.preventDefault(); if (!sample || busy) return;
    const attempt = sample; setBusy(true); $('sample-status').classList.remove('error');
    try {
      const result = await request('/api/check', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({puzzleId:attempt.puzzleId,guess:$('guess').value}) });
      sample = null; $('answer-form').hidden = true;
      progress(2); clock();
      const feedback = $('feedback'); feedback.replaceChildren(node('div', result.correct ? 'CORRECT / CIRCUIT CLOSED' : 'NOT QUITE / HERE’S THE SOLUTION', 'result-label'), node('h3', result.correct ? 'Well played.' : 'A useful wrong turn.'));
      if (result.answer !== undefined) feedback.append(node('p', `Accepted answer: ${result.answer}`));
      if (result.explanation) {
        feedback.append(node('p', result.explanation.summary));
        for (const [key,value] of Object.entries(result.explanation)) if (key !== 'summary') renderValue(feedback,key,value);
      } else feedback.append(node('p', result.remark));
      const actions = node('div', undefined, 'feedback-actions');
      const again = node('button', 'Another on the house ↗', 'button primary'); again.type = 'button'; again.addEventListener('click', () => loadPuzzle(attempt.game));
      const next = node('a','Bring your agent ↗','button'); next.href='/connect.html'; actions.append(again, next); feedback.append(actions); feedback.hidden=false;
      $('sample-status').textContent='Sample completed. No standings changed. Generate another to keep exploring.';
    } catch (error) { $('sample-status').textContent = `${error.message} If the response was lost, this attempt may already be consumed. You can generate a new free puzzle.`; $('sample-status').classList.add('error'); }
    finally { setBusy(false); }
  });
  request('/api/menu').then(menu => { document.querySelectorAll('[data-price]').forEach(e => { if (menu.pricing?.[e.dataset.price]) e.textContent=menu.pricing[e.dataset.price]; }); }).catch(() => {});
  request('/api/leaderboard/walk').then(data => {
    const body=$('standings-body'); body.replaceChildren();
    for (const row of data.board.slice(0,5)) { const tr=node('tr'); tr.append(node('td',row.designation),node('td',String(row.bestStreak)),node('td',`${row.solved} / ${row.plays}`)); body.append(tr); }
    $('board-state').textContent='LIVE'; $('board-note').textContent=data.board.length ? 'Confirmed records from this server. Free samples are excluded.' : 'No ranked records yet. Free samples never appear on this board.';
  }).catch(() => { $('board-state').textContent='UNAVAILABLE'; $('board-note').textContent='Standings are temporarily unavailable. No placeholder scores are shown.'; });
}
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click',async () => {
  const status=$(button.dataset.copy+'-status');
  try { await navigator.clipboard.writeText($(button.dataset.copy).textContent); status.textContent='Copied.'; }
  catch { status.textContent='Select and copy the example manually.'; }
}));
