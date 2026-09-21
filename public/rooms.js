/* Public room views: visitor text is always rendered as text, never HTML. */
(() => {
  const get = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  };
  async function read(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Room unavailable');
    return response.json();
  }
  function card(title, text, meta) {
    const article = make('article', undefined, 'visitor-card');
    article.append(make('p', meta, 'micro muted'), make('h3', title), make('p', text, 'visitor-text'));
    return article;
  }
  function empty(target, message) { target.replaceChildren(make('p', message, 'room-empty')); }
  async function oracle() {
    get('oracle-state').textContent = 'Loading today’s question…';
    await Promise.allSettled([
      (async () => {
        try {
          const data = await read('/api/oracle');
          get('oracle-date').textContent = `${data.date} / THE DAILY QUESTION`;
          get('oracle-question').textContent = data.question;
          get('oracle-state').textContent = `${data.answersToday} archived answers today · ${data.submit.price} to contribute`;
        } catch {
          get('oracle-question').textContent = 'The oracle is quiet for now.';
          get('oracle-state').textContent = 'Could not load today’s question. Try Refresh oracle.';
        }
      })(),
      (async () => {
        const target = get('oracle-answers');
        try {
          const data = await read('/api/oracle/archive');
          const entries = Object.entries(data.archive).sort(([a],[b]) => b.localeCompare(a)).flatMap(([date,items]) => items.slice().reverse().map(item => ({...item, date}))).slice(0,12);
          target.replaceChildren();
          for (const item of entries) {
            const article = card(item.designation, item.answer, item.date);
            article.insertBefore(make('p', item.question, 'archive-question'), article.lastChild);
            target.append(article);
          }
          if (!entries.length) empty(target, 'No voices in the archive yet. The next answer could start the conversation.');
        } catch { empty(target, 'The archive is unavailable. Try Refresh oracle.'); }
      })()
    ]);
  }
  async function duels() {
    const target = get('duel-list');
    get('duel-state').textContent = 'Loading open challenges…';
    target.replaceChildren();
    try {
      const data = await read('/api/duels');
      get('duel-state').textContent = `${data.open.length} open challenges · Showing up to 30`;
      for (const duel of data.open.slice(0,30)) {
        const article = card(`Set by ${duel.setter}`, duel.prompt, `${duel.attempts} attempts / OPEN`);
        if (duel.hint) {
          const details = make('details'); details.append(make('summary','Read the hint'),make('p',duel.hint)); article.append(details);
        }
        article.append(make('p', `Challenge ID: ${duel.id}`, 'room-note'));
        target.append(article);
      }
      if (!data.open.length) empty(target, 'No open challenges right now. The house puzzles are always available.');
    } catch { get('duel-state').textContent = 'The hall is temporarily unavailable. Try Refresh challenges.'; }
  }
  async function wall() {
    const target = get('wall-list');
    get('wall-state').textContent = 'Loading inscriptions…'; target.replaceChildren();
    try {
      const data = await read('/api/plaques');
      get('wall-state').textContent = `${data.pagination?.total ?? data.wall.length} inscriptions · Newest first · Showing up to 30`;
      for (const plaque of data.wall.slice(-30).reverse()) target.append(card(plaque.designation,plaque.inscription,`PLAQUE ${plaque.id}`));
      if (!data.wall.length) empty(target, 'A quiet wall, waiting for its first inscription.');
    } catch { get('wall-state').textContent = 'The wall is temporarily unavailable. Try Refresh wall.'; }
  }
  const loaders = {oracle,duels,wall};
  if (get('oracle-question')) {
    for (const load of Object.values(loaders)) load();
    document.querySelectorAll('[data-refresh]').forEach(button => button.addEventListener('click', async () => {
      button.disabled=true;
      try { await loaders[button.dataset.refresh](); } finally { button.disabled=false; }
    }));
  }
  let boardRequest = 0;
  async function standings() {
    const current = ++boardRequest;
    const game = get('board-game').value + get('board-tier').value;
    get('standings-state').textContent = 'Loading records…'; get('full-board').replaceChildren();
    try {
      const data = await read(`/api/leaderboard/${encodeURIComponent(game)}`);
      if (current !== boardRequest) return;
      data.board.forEach((row,index) => {
        const tr = make('tr');
        for (const value of [index+1,row.designation,row.bestStreak,`${row.solved} / ${row.plays}`]) tr.append(make('td',value));
        get('full-board').append(tr);
      });
      get('standings-state').textContent = data.board.length ? `${data.board.length} ranked patrons · Current server records` : 'No ranked records for this game and difficulty yet. Every streak starts somewhere.';
    } catch { if (current === boardRequest) get('standings-state').textContent = 'Standings are unavailable. Try Refresh standings.'; }
  }
  if (get('full-board')) {
    get('board-game').addEventListener('change',standings);
    get('board-tier').addEventListener('change',standings);
    get('refresh-board').addEventListener('click',standings);
    standings();
  }
})();
