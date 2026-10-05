(() => {
  'use strict';

  const API = 'api/';
  const state = {
    board: null,
    search: '',
    cardSortables: [],
    columnSortable: null,
    loading: false
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const boardEl = $('#board');
  const emptyState = $('#emptyState');
  const toastRegion = $('#toastRegion');

  function icons() {
    if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.textContent = message;
    toastRegion.append(el);
    window.setTimeout(() => el.remove(), 3000);
  }

  function setBusy(value) {
    state.loading = value;
    document.body.classList.toggle('busy', value);
  }

  async function api(action, options = {}) {
    const init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    };
    if (options.body !== undefined) {
      init.method = init.method === 'GET' ? 'POST' : init.method;
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const url = API + '?action=' + encodeURIComponent(action) + (options.query ? '&' + new URLSearchParams(options.query) : '');
    let response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new Error('Server non raggiungibile.');
    }
    let data;
    try {
      data = await response.json();
    } catch (_) {
      throw new Error('Risposta server non valida.');
    }
    if (response.status === 401) {
      showLogin();
      throw new Error('Sessione scaduta.');
    }
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || 'Operazione non riuscita.');
    }
    return data;
  }

  async function boot() {
    icons();
    bindGlobalEvents();
    try {
      const status = await api('status');
      if (status.setup_required) {
        $('#setupDialog').showModal();
        return;
      }
      if (!status.authenticated) {
        showLogin();
        return;
      }
      $('#logoutBtn').hidden = false;
      await loadBoard();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function showLogin() {
    const dialog = $('#loginDialog');
    $('#logoutBtn').hidden = true;
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => $('#loginPassword').focus(), 50);
  }

  async function loadBoard() {
    setBusy(true);
    try {
      const data = await api('board');
      state.board = data.board;
      renderBoard();
    } finally {
      setBusy(false);
    }
  }

  function renderBoard() {
    destroySortables();
    boardEl.innerHTML = '';
    const board = state.board;
    if (!board) return;

    $('#boardTitle').textContent = board.name;
    const total = board.columns.reduce((sum, col) => sum + col.cards.length, 0);
    $('#boardMeta').textContent = board.columns.length + (board.columns.length === 1 ? ' colonna' : ' colonne') + ' · ' + total + (total === 1 ? ' card' : ' card');
    emptyState.hidden = board.columns.length > 0;
    boardEl.hidden = board.columns.length === 0;

    const columnTemplate = $('#columnTemplate');
    board.columns.forEach(col => {
      const fragment = columnTemplate.content.cloneNode(true);
      const columnEl = $('.column', fragment);
      columnEl.dataset.columnId = col.id;
      $('.column-title', fragment).textContent = col.name;
      $('.column-count', fragment).textContent = col.cards.length;
      const list = $('.card-list', fragment);
      col.cards.forEach(card => list.append(renderCard(card)));
      boardEl.append(fragment);
    });

    applySearch();
    bindBoardEvents();
    initSortables();
    icons();
  }

  function renderCard(card) {
    const fragment = $('#cardTemplate').content.cloneNode(true);
    const el = $('.task-card', fragment);
    el.dataset.cardId = card.id;
    el.dataset.label = card.label || '';
    $('.task-title', fragment).textContent = card.title;

    const desc = $('.task-description', fragment);
    if (card.description) {
      desc.textContent = card.description;
      desc.hidden = false;
    }

    const label = $('.task-label', fragment);
    if (card.label) {
      label.textContent = labelName(card.label);
      label.hidden = false;
    }

    const due = $('.task-due', fragment);
    if (card.due_date) {
      const dueDate = new Date(card.due_date + 'T23:59:59');
      $('span', due).textContent = formatDate(card.due_date);
      due.hidden = false;
      if (dueDate < new Date()) due.classList.add('overdue');
    }
    return fragment;
  }

  function labelName(value) {
    return ({ magenta: 'Focus', amber: 'Attesa', teal: 'Pronto', blue: 'Info', violet: 'Idea' })[value] || value;
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' }).format(new Date(value + 'T12:00:00'));
    } catch (_) {
      return value;
    }
  }

  function bindGlobalEvents() {
    $('#loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const error = $('#loginError');
      error.hidden = true;
      try {
        await api('login', { body: { password: $('#loginPassword').value } });
        $('#loginPassword').value = '';
        $('#loginDialog').close();
        $('#logoutBtn').hidden = false;
        await loadBoard();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    });

    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('logout', { body: {} }); } catch (_) {}
      state.board = null;
      boardEl.innerHTML = '';
      showLogin();
    });

    $('#refreshBtn').addEventListener('click', loadBoard);
    $('#addColumnBtn').addEventListener('click', () => openColumnDialog());
    $('#emptyAddColumnBtn').addEventListener('click', () => openColumnDialog());
    $('#renameBoardBtn').addEventListener('click', openBoardDialog);

    $('#searchInput').addEventListener('input', e => {
      state.search = e.target.value.trim().toLowerCase();
      applySearch();
    });

    document.addEventListener('keydown', e => {
      if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        $('#searchInput').focus();
      }
      if (e.key === 'Escape') closePopovers();
    });

    $('#columnForm').addEventListener('submit', saveColumn);
    $('#boardForm').addEventListener('submit', saveBoard);
    $('#cardForm').addEventListener('submit', saveCard);
    $('#archiveCardBtn').addEventListener('click', archiveCurrentCard);

    $$('.dialog-close, .dialog-cancel').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('dialog').close());
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.column-menu-wrap')) closePopovers();
    });
  }

  function bindBoardEvents() {
    $$('.add-card-btn', boardEl).forEach(btn => {
      btn.addEventListener('click', () => {
        const columnId = btn.closest('.column').dataset.columnId;
        openCardDialog(null, columnId);
      });
    });

    $$('.column-menu-btn', boardEl).forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const pop = $('.column-popover', btn.closest('.column-menu-wrap'));
        const willOpen = pop.hidden;
        closePopovers();
        pop.hidden = !willOpen;
      });
    });

    $$('[data-action="rename-column"]', boardEl).forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.column').dataset.columnId;
        const col = findColumn(id);
        closePopovers();
        openColumnDialog(col);
      });
    });

    $$('[data-action="delete-column"]', boardEl).forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.column').dataset.columnId;
        const col = findColumn(id);
        closePopovers();
        if (!confirm('Eliminare la colonna "' + col.name + '" e tutte le sue card?')) return;
        try {
          await api('column:delete', { body: { id } });
          await loadBoard();
          toast('Colonna eliminata.');
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    $$('.task-card', boardEl).forEach(cardEl => {
      const open = e => {
        if (e.target.closest('.card-edit')) {
          e.stopPropagation();
        }
        const card = findCard(cardEl.dataset.cardId);
        openCardDialog(card, card.column_id);
      };
      cardEl.addEventListener('click', open);
      cardEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
      });
    });
  }

  function closePopovers() {
    $$('.popover').forEach(el => el.hidden = true);
  }

  function applySearch() {
    const q = state.search;
    $$('.task-card', boardEl).forEach(el => {
      const card = findCard(el.dataset.cardId);
      if (!card) return;
      const hay = [card.title, card.description, card.label].join(' ').toLowerCase();
      el.classList.toggle('filtered-out', !!q && !hay.includes(q));
    });
  }

  function initSortables() {
    if (!window.Sortable) return;

    state.columnSortable = new Sortable(boardEl, {
      animation: 160,
      handle: '.column-grip',
      draggable: '.column',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: async () => {
        const ids = $$('.column', boardEl).map(el => Number(el.dataset.columnId));
        try {
          await api('column:reorder', { body: { ids } });
          reorderLocalColumns(ids);
        } catch (err) { toast(err.message, 'error'); await loadBoard(); }
      }
    });

    $$('.card-list', boardEl).forEach(list => {
      const sortable = new Sortable(list, {
        group: 'cards',
        animation: 150,
        draggable: '.task-card',
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        emptyInsertThreshold: 28,
        onEnd: async evt => {
          const cardId = Number(evt.item.dataset.cardId);
          const fromColumnId = Number(evt.from.closest('.column').dataset.columnId);
          const toColumnId = Number(evt.to.closest('.column').dataset.columnId);
          try {
            await api('card:move', {
              body: {
                id: cardId,
                from_column_id: fromColumnId,
                to_column_id: toColumnId,
                new_index: evt.newIndex
              }
            });
            await loadBoard();
          } catch (err) {
            toast(err.message, 'error');
            await loadBoard();
          }
        }
      });
      state.cardSortables.push(sortable);
    });
  }

  function destroySortables() {
    state.cardSortables.forEach(s => s.destroy());
    state.cardSortables = [];
    if (state.columnSortable) {
      state.columnSortable.destroy();
      state.columnSortable = null;
    }
  }

  function reorderLocalColumns(ids) {
    if (!state.board) return;
    const map = new Map(state.board.columns.map(c => [Number(c.id), c]));
    state.board.columns = ids.map(id => map.get(Number(id))).filter(Boolean);
  }

  function findColumn(id) {
    return state.board?.columns.find(c => Number(c.id) === Number(id));
  }

  function findCard(id) {
    for (const col of state.board?.columns || []) {
      const card = col.cards.find(c => Number(c.id) === Number(id));
      if (card) return card;
    }
    return null;
  }

  function openColumnDialog(column = null) {
    $('#columnId').value = column?.id || '';
    $('#columnName').value = column?.name || '';
    $('#columnDialogTitle').textContent = column ? 'Rinomina colonna' : 'Nuova colonna';
    $('#columnDialog').showModal();
    window.setTimeout(() => $('#columnName').focus(), 40);
  }

  async function saveColumn(e) {
    e.preventDefault();
    const id = $('#columnId').value;
    const name = $('#columnName').value.trim();
    if (!name) return;
    try {
      await api(id ? 'column:update' : 'column:create', { body: id ? { id, name } : { name } });
      $('#columnDialog').close();
      await loadBoard();
    } catch (err) { toast(err.message, 'error'); }
  }

  function openBoardDialog() {
    $('#boardName').value = state.board?.name || '';
    $('#boardDialog').showModal();
    window.setTimeout(() => $('#boardName').focus(), 40);
  }

  async function saveBoard(e) {
    e.preventDefault();
    const name = $('#boardName').value.trim();
    if (!name) return;
    try {
      await api('board:update', { body: { name } });
      $('#boardDialog').close();
      await loadBoard();
    } catch (err) { toast(err.message, 'error'); }
  }

  function openCardDialog(card = null, columnId) {
    const column = findColumn(columnId || card?.column_id);
    $('#cardId').value = card?.id || '';
    $('#cardColumnId').value = column?.id || '';
    $('#cardTitle').value = card?.title || '';
    $('#cardDescription').value = card?.description || '';
    $('#cardLabel').value = card?.label || '';
    $('#cardDueDate').value = card?.due_date || '';
    $('#cardColumnLabel').textContent = column?.name || 'Card';
    $('#cardDialogTitle').textContent = card ? 'Modifica attività' : 'Nuova attività';
    $('#archiveCardBtn').hidden = !card;
    $('#cardDialog').showModal();
    window.setTimeout(() => $('#cardTitle').focus(), 40);
  }

  async function saveCard(e) {
    e.preventDefault();
    const id = $('#cardId').value;
    const body = {
      id: id || undefined,
      column_id: $('#cardColumnId').value,
      title: $('#cardTitle').value.trim(),
      description: $('#cardDescription').value.trim(),
      label: $('#cardLabel').value,
      due_date: $('#cardDueDate').value || null
    };
    if (!body.title) return;
    try {
      await api(id ? 'card:update' : 'card:create', { body });
      $('#cardDialog').close();
      await loadBoard();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function archiveCurrentCard() {
    const id = $('#cardId').value;
    if (!id) return;
    if (!confirm('Archiviare questa card?')) return;
    try {
      await api('card:archive', { body: { id } });
      $('#cardDialog').close();
      await loadBoard();
      toast('Card archiviata.');
    } catch (err) { toast(err.message, 'error'); }
  }

  boot();
})();
