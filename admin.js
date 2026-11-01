import { LOAD_TIMEOUT_MS, bubble, clock, h, loadingView, memory, offerCard, quoteTag, request, retryView, won } from './common.js';

const TOKEN_KEY = 'nappum.admin';
const POLL_MS = 8000;

const app = document.getElementById('app');
const TABS = [
  ['today', '대시보드'],
  ['chats', '상담'],
  ['products', '품목·가격'],
  ['company', '회사·정책'],
  ['rules', '흥정 규칙'],
  ['alerts', '알림'],
];

const QR_SCRIPT = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const SAMPLE_PRICES = { 'GLV-NBR': 12000, 'MSK-P2': 28000, 'FLM-500': 9500, 'TIE-300': 3200 };

const STAGES = [
  ['inquiry', '문의', ''],
  ['haggling', '흥정 중', ''],
  ['pending', '승인 대기', 'warn'],
  ['approved', '승인', 'good'],
  ['rejected', '반려', 'bad'],
];

let token = memory.get(TOKEN_KEY);
let tab = 'today';
let openChatId = null;
let chatStage = 'all';
let chatSearch = '';
let productSearch = '';
const openRows = new Set();
let settings = null;
let paces = {};
let main;
let nav;

const call = (path, options = {}) =>
  request(path, { ...options, headers: { 'x-admin-token': token } });

function takeTokenFromLink() {
  const match = location.hash.match(/^#t=([0-9a-f]+)$/);
  if (!match) return;
  token = match[1];
  memory.set(TOKEN_KEY, token);
  history.replaceState(null, '', location.pathname);
}

function showLogin(error) {
  const input = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  app.replaceChildren(
    h(
      'main',
      { class: 'entry' },
      h(
        'section',
        { class: 'entry-card' },
        h('p', { class: 'eyebrow' }, '납품 상담 관리'),
        h('h1', null, '관리자 비밀번호'),
        h(
          'form',
          {
            onsubmit(event) {
              event.preventDefault();
              token = input.value.trim();
              memory.set(TOKEN_KEY, token);
              start();
            },
          },
          h('label', null, '비밀번호', input),
          h('p', { class: 'form-error', role: 'alert' }, error || ''),
          h('button', { class: 'primary wide', type: 'submit' }, '들어가기'),
        ),
      ),
    ),
  );
  input.focus();
}

function drawNav() {
  nav.replaceChildren(
    ...TABS.map(([id, label]) =>
      h(
        'button',
        {
          type: 'button',
          class: id === tab ? 'on' : '',
          onclick() {
            tab = id;
            openChatId = null;
            drawNav();
            draw();
          },
        },
        label,
      ),
    ),
  );
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('span', null, label), h('b', null, value), sub && h('small', null, sub));
}

async function decideQuote(id, status, note = '') {
  try {
    await call(`/admin/quotes/${id}`, { method: 'POST', body: { status, note } });
    draw();
  } catch (err) {
    alert(err.message);
  }
}

// 건수가 많아도 한눈에 보이게 한 줄로 접어 둔다. 화면을 다시 그려도 펼친 줄은 유지한다.
function foldRow(id, summary, ...body) {
  return h(
    'details',
    {
      class: 'item fold',
      open: openRows.has(id),
      ontoggle(event) {
        if (event.target.open) openRows.add(id);
        else openRows.delete(id);
      },
    },
    h('summary', null, summary),
    body,
  );
}

function quoteRow(quote) {
  const memo = h('input', { placeholder: '구매자에게 전할 말(선택)', maxLength: 300 });
  const decide = (status) => decideQuote(quote.id, status, memo.value);
  const more = quote.items.length > 1 ? ` 외 ${quote.items.length - 1}건` : '';
  return foldRow(
    quote.id,
    [
      h('span', { class: 'item-head' }, h('strong', { class: 'clip' }, quote.buyer.company), h('b', null, won(quote.total))),
      h('span', { class: 'sub clip' }, `${quote.items[0].name}${more} · ${clock(quote.createdAt)}`),
      quote.belowTarget.length > 0 && h('span', { class: 'tag warn' }, '적정가 미만'),
    ],
    h('p', { class: 'sub' }, `${quote.no} · ${quote.buyer.name} · ${quote.buyer.phone}`),
    quote.belowTarget.length > 0 && h('p', { class: 'sub' }, `적정가 미만 품목: ${quote.belowTarget.join(', ')}`),
    h(
      'table',
      { class: 'mini' },
      h(
        'tbody',
        null,
        quote.items.map((item) =>
          h(
            'tr',
            null,
            h('td', null, item.name),
            h('td', null, `${item.qty.toLocaleString('ko-KR')}${item.unit}`),
            h('td', null, won(item.unitPrice)),
            h('td', null, won(item.supply)),
          ),
        ),
      ),
    ),
    quote.items.some((i) => i.conditions.length) &&
      h('p', { class: 'sub' }, `조건: ${[...new Set(quote.items.flatMap((i) => i.conditions))].join(', ')}`),
    quote.note && h('p', { class: 'sub' }, `메모: ${quote.note}`),
    h('p', { class: 'sum' }, `합계 ${won(quote.total)}`, h('small', null, ' 부가세 포함')),
    memo,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', type: 'button', onclick: () => decide('approved') }, '승인'),
      h('button', { class: 'ghost', type: 'button', onclick: () => decide('rejected') }, '반려'),
      h('button', { class: 'link', type: 'button', onclick: () => openChat(quote.chatId) }, '대화 보기'),
    ),
  );
}

function ticketRow(ticket) {
  const answer = h('textarea', { rows: 2, placeholder: '구매자에게 보낼 답변', maxLength: 1500 });
  const toFaq = h('input', { type: 'checkbox', checked: ticket.kind === 'unknown_question' });
  const close = async (send) => {
    try {
      await call(`/admin/tickets/${ticket.id}`, {
        method: 'POST',
        body: { answer: send ? answer.value : '', addToFaq: toFaq.checked },
      });
      // 서버에서 자주 묻는 질문이 늘었으니 다시 받는다. 안 그러면 다음 저장 때 덮어쓴다.
      if (send && toFaq.checked) ({ settings } = await call('/admin/settings'));
      draw();
    } catch (err) {
      alert(err.message);
    }
  };
  return foldRow(
    ticket.id,
    [
      h('span', { class: 'item-head' }, h('strong', { class: 'clip' }, ticket.company), h('span', { class: 'tag warn' }, ticket.label)),
      h('span', { class: 'sub clip' }, ticket.question || ticket.summary),
    ],
    ticket.question && h('p', { class: 'quote' }, ticket.question),
    h('p', { class: 'sub' }, ticket.summary),
    answer,
    h('label', { class: 'check' }, toFaq, h('span', null, '이 답변을 자주 묻는 질문에 추가')),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', type: 'button', onclick: () => close(true) }, '답변 보내기'),
      h('button', { class: 'ghost', type: 'button', onclick: () => close(false) }, '처리 완료'),
      h('button', { class: 'link', type: 'button', onclick: () => openChat(ticket.chatId) }, '대화 보기'),
    ),
  );
}

function showChats(stage) {
  chatStage = stage;
  openChat(null);
}

function stageChips(chats) {
  const chip = (id, label, count) =>
    h(
      'button',
      { class: `chip ${tab === 'chats' && chatStage === id ? 'on' : ''}`, type: 'button', onclick: () => showChats(id) },
      label,
      h('b', null, count),
    );
  return h(
    'div',
    { class: 'chips' },
    chip('all', '전체', chats.length),
    STAGES.map(([id, label]) => chip(id, label, chats.filter((c) => c.stage === id).length)),
  );
}

function chatRow(chat) {
  const [, label, tone] = STAGES.find(([id]) => id === chat.stage);
  const first = chat.items[0];
  const more = chat.items.length > 1 ? ` 외 ${chat.items.length - 1}건` : '';
  return h(
    'button',
    { class: 'list-row', type: 'button', onclick: () => openChat(chat.id) },
    h(
      'span',
      { class: 'item-head' },
      h('strong', { class: 'clip' }, chat.buyer.company),
      h(
        'span',
        { class: 'row-tags' },
        chat.attention && h('span', { class: 'tag bad' }, '확인 필요'),
        chat.underTarget && h('span', { class: 'tag warn' }, '적정가 미만'),
        h('span', { class: `tag ${tone}` }, label),
        h('span', { class: `tag ${chat.mode === 'human' ? 'good' : ''}` }, chat.mode === 'human' ? '담당자' : 'AI'),
      ),
    ),
    h('span', { class: 'sub' }, `${chat.buyer.name} · ${chat.buyer.phone} · ${clock(chat.updatedAt)}`),
    first &&
      h(
        'span',
        { class: 'deal' },
        `${first.name} ${first.qty.toLocaleString('ko-KR')}${first.unit} · ${won(first.unitPrice)}${more}`,
        chat.total != null && h('b', null, ` · 합계 ${won(chat.total)}`),
      ),
    h('span', { class: 'sub clip' }, chat.lastText || '아직 메시지가 없습니다.'),
  );
}

const isSample = (product) => SAMPLE_PRICES[product.id] === product.list;

function goTo(target) {
  tab = target;
  openChatId = null;
  drawNav();
  draw();
}

// 공장에 링크를 보내기 전에 끝낼 일. 다 끝나면 대시보드에서 사라진다.
function setupNotice(pushDevices) {
  const { company } = settings;
  const todo = [
    settings.products.some(isSample) && ['products', '예시 품목을 실제 품목과 가격으로 바꾸기'],
    /^[0-]+$/.test(company.phone) && ['company', '회사 전화번호 넣기'],
    company.email.endsWith('@example.com') && ['company', '회사 이메일 넣기'],
    company.address.startsWith('예시') && ['company', '회사 주소 넣기'],
    !company.privacyOfficer && ['company', '개인정보 담당자 넣기'],
    pushDevices === 0 && ['alerts', '알림 켜기'],
  ].filter(Boolean);
  if (todo.length === 0) return [];
  return [
    h(
      'section',
      { class: 'setup' },
      h('h2', null, '공장에 보내기 전에 할 일'),
      todo.map(([target, label]) => h('button', { class: 'link', type: 'button', onclick: () => goTo(target) }, label)),
    ),
  ];
}

async function loadOverview() {
  const data = await call('/admin/overview');
  const waiting = data.quotes.length + data.tickets.length;
  document.title = waiting ? `(${waiting}) 납품 상담 관리` : '납품 상담 관리';
  return data;
}

async function drawToday() {
  const data = await loadOverview();
  const limit = settings?.limits?.dailyMessages;
  const { stats } = data;
  main.replaceChildren(
    h('h1', null, '대시보드'),
    h(
      'div',
      { class: 'tiles' },
      tile('오늘 새 상담', stats.newToday, `전체 ${data.chats.length}건`),
      tile('승인 대기 견적', data.quotes.length, data.quotes.length ? `합계 ${won(stats.pendingTotal)}` : null),
      tile('처리할 요청', data.tickets.length),
      tile('이번 달 승인', won(stats.approvedTotal), `${stats.approvedCount}건 · 부가세 포함`),
    ),
    h(
      'p',
      { class: 'sub' },
      `오늘 AI 응답 ${data.usage.messages}회${limit ? ` / 하루 한도 ${limit}회` : ''} · 비용 약 $${data.usage.costUsd.toFixed(2)}`,
    ),
    // 할 일 안내가 길어도 핵심 숫자가 밀려나지 않게 숫자 아래에 둔다.
    ...setupNotice(data.pushDevices),
    stageChips(data.chats),
    h(
      'div',
      { class: 'columns' },
      h(
        'section',
        null,
        h('h2', null, '견적 승인'),
        data.quotes.length ? data.quotes.map(quoteRow) : h('p', { class: 'empty' }, '승인할 견적이 없습니다.'),
      ),
      h(
        'section',
        null,
        h('h2', null, '요청함'),
        data.tickets.length
          ? data.tickets.map(ticketRow)
          : h('p', { class: 'empty' }, '담당자 연결 요청이나 AI가 답하지 못한 질문이 없습니다.'),
      ),
    ),
    h(
      'div',
      { class: 'item-head' },
      h('h2', null, '최근 상담'),
      h('button', { class: 'link', type: 'button', onclick: () => showChats('all') }, '전체 보기'),
    ),
    data.chats.length
      ? h('div', { class: 'list' }, data.chats.slice(0, 5).map(chatRow))
      : h('p', { class: 'empty' }, '아직 들어온 상담이 없습니다.'),
  );
}

function openChat(id) {
  tab = 'chats';
  openChatId = id;
  drawNav();
  draw();
}

async function drawChatList() {
  const { chats } = await loadOverview();
  const list = h('div', { class: 'list' });
  const paint = () => {
    const word = chatSearch.trim().toLowerCase();
    const shown = chats.filter(
      (chat) =>
        (chatStage === 'all' || chat.stage === chatStage) &&
        `${chat.buyer.company} ${chat.buyer.name} ${chat.buyer.phone}`.toLowerCase().includes(word),
    );
    const empty = chats.length ? '조건에 맞는 상담이 없습니다.' : '아직 들어온 상담이 없습니다.';
    list.replaceChildren(...(shown.length ? shown.map(chatRow) : [h('p', { class: 'empty' }, empty)]));
  };
  const search = h('input', {
    class: 'search',
    type: 'search',
    value: chatSearch,
    placeholder: '회사, 담당자, 연락처 검색',
    'aria-label': '상담 검색',
    oninput(event) {
      chatSearch = event.target.value;
      paint();
    },
  });
  paint();
  main.replaceChildren(h('h1', null, '상담'), stageChips(chats), search, list);
}

// 사장님 휴대폰의 전화·문자 앱을 바로 연다.
function contactLinks(chat) {
  const phone = chat.buyer.phone.replace(/\D/g, '');
  const quote = chat.quotes.at(-1);
  const decided = quote && quote.status !== 'pending' ? ` 견적 ${quote.no}이(가) ${quote.status === 'approved' ? '승인' : '반려'}되었습니다.` : '';
  const text = `안녕하세요, ${settings.company.name}입니다.${decided}`;
  return h(
    'div',
    { class: 'row' },
    h('a', { class: 'ghost-link', href: `tel:${phone}` }, '전화 걸기'),
    h('a', { class: 'ghost-link', href: `sms:${phone}?&body=${encodeURIComponent(text)}` }, '문자 보내기'),
  );
}

async function drawChat(id) {
  const chat = await call(`/admin/chats/${id}`);
  const log = h('div', { class: 'log static' });
  for (const message of chat.messages) {
    log.append(bubble(message, { agent: 'AI' }));
    for (const card of message.cards || []) {
      if (card.kind === 'offer') log.append(offerCard(card));
    }
  }
  const input = h('textarea', { rows: 2, maxLength: 1500, placeholder: '구매자에게 직접 답변. 보내면 담당자 응대로 바뀝니다.' });

  const post = async (path, body) => {
    try {
      await call(path, { method: 'POST', body });
      draw();
    } catch (err) {
      alert(err.message);
    }
  };

  main.replaceChildren(
    h('button', { class: 'link', type: 'button', onclick: () => openChat(null) }, '← 상담 목록'),
    h('h1', null, chat.buyer.company),
    h('p', { class: 'sub' }, `${chat.buyer.name} · ${chat.buyer.phone}`),
    contactLinks(chat),
    h(
      'div',
      { class: 'split' },
      h(
        'section',
        null,
        log,
        h(
          'form',
          {
            class: 'staff-reply',
            onsubmit(event) {
              event.preventDefault();
              if (input.value.trim()) post(`/admin/chats/${id}/reply`, { text: input.value });
            },
          },
          input,
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'primary', type: 'submit' }, '답변 보내기'),
            h(
              'button',
              {
                class: 'ghost',
                type: 'button',
                onclick: () => post(`/admin/chats/${id}/mode`, { mode: chat.mode === 'human' ? 'ai' : 'human' }),
              },
              chat.mode === 'human' ? 'AI에게 돌려주기' : '내가 맡기',
            ),
          ),
        ),
      ),
      h(
        'aside',
        null,
        h('h2', null, '흥정 상황'),
        chat.negotiations.length
          ? chat.negotiations.map((neg) =>
              h(
                'div',
                { class: 'item' },
                h('strong', null, neg.name),
                h('p', { class: 'sub' }, `흥정 ${neg.rounds}회`),
                neg.offer && h('p', null, `현재 제시 ${won(neg.offer.unitPrice)}`),
                neg.target != null && h('p', { class: 'sub' }, `적정가 ${won(neg.target)}`),
                neg.floor != null && h('p', { class: 'sub' }, `절대 하한가 ${won(neg.floor)}`),
              ),
            )
          : h('p', { class: 'empty' }, '아직 흥정이 없습니다.'),
        h('h2', null, '견적'),
        chat.quotes.length
          ? chat.quotes.map((q) =>
              h(
                'div',
                { class: 'item' },
                h('div', { class: 'item-head' }, h('strong', null, q.no), quoteTag(q.status)),
                h('p', null, won(q.total)),
                q.belowTarget.length > 0 && h('p', null, h('span', { class: 'tag warn' }, '적정가 미만')),
                q.status === 'pending' &&
                  h(
                    'div',
                    { class: 'row' },
                    h('button', { class: 'primary', type: 'button', onclick: () => decideQuote(q.id, 'approved') }, '승인'),
                    h('button', { class: 'ghost', type: 'button', onclick: () => decideQuote(q.id, 'rejected') }, '반려'),
                  ),
              ),
            )
          : h('p', { class: 'empty' }, '아직 견적이 없습니다.'),
        h(
          'button',
          {
            class: 'link danger',
            type: 'button',
            async onclick() {
              if (!confirm(`${chat.buyer.company} 상담 기록을 모두 지울까요? 대화와 견적이 함께 지워지고 되돌릴 수 없습니다.`)) return;
              try {
                await call(`/admin/chats/${id}/delete`, { method: 'POST', body: {} });
                openChat(null);
              } catch (err) {
                alert(err.message);
              }
            },
          },
          '상담 기록 삭제',
        ),
      ),
    ),
  );
  log.scrollTop = log.scrollHeight;
}

function field(label, object, key, { type = 'text', hint, cls, rows } = {}) {
  const props = {
    value: object[key] ?? '',
    oninput(event) {
      object[key] = type === 'number' ? Number(event.target.value) : event.target.value;
    },
  };
  const control = rows ? h('textarea', { ...props, rows }) : h('input', { ...props, type, step: 'any' });
  return h('label', { class: cls || '' }, label, control, hint && h('small', null, hint));
}

// 값이 없으면 항목을 지워서 흥정 규칙 탭의 기본값을 따르게 한다.
function choice(label, object, key, options, hint) {
  const control = h(
    'select',
    {
      onchange(event) {
        const [value] = options.find(([id]) => String(id) === event.target.value);
        if (value === '') delete object[key];
        else object[key] = value;
      },
    },
    options.map(([id, text]) => h('option', { value: id, selected: id === (object[key] ?? '') }, text)),
  );
  return h('label', null, label, control, hint && h('small', null, hint));
}

function saveBar() {
  const status = h('span', { class: 'sub', role: 'status' });
  return h(
    'div',
    { class: 'savebar' },
    status,
    h(
      'button',
      {
        class: 'primary',
        type: 'button',
        async onclick() {
          status.textContent = '저장 중…';
          try {
            await call('/admin/settings', { method: 'PUT', body: { settings } });
            status.textContent = '저장했습니다. 다음 답변부터 적용됩니다.';
          } catch (err) {
            status.textContent = err.message;
          }
        },
      },
      '저장',
    ),
  );
}

function productForm(product) {
  const preview = h('p', { class: 'path' });
  const range = h('p', { class: 'range' });
  const paintRange = () => {
    if (!(product.list > 0 && product.floor > 0)) {
      range.textContent = '정가와 절대 하한가를 넣어 주세요.';
      return;
    }
    const aim = product.target > 0 ? `말로는 ${won(product.target)}까지만 내려갑니다. 그 밑은 수량이나 조건을 받을 때만 내려가고, ` : '';
    range.textContent = `${won(product.list)}에서 시작합니다. ${aim}${won(product.floor)} 밑으로는 절대 합의하지 않습니다.`;
  };
  paintRange();
  const showPreview = async () => {
    try {
      const data = await call('/admin/preview', {
        method: 'POST',
        body: { productId: product.id, qty: product.moq },
      });
      const steps = data.path.map((p) => won(p.price)).join(' → ');
      const more = data.lowest < data.target ? ` 조건을 모두 받으면 ${won(data.lowest)}까지 내려갑니다.` : '';
      preview.textContent = `최소 수량 기준, 구매자가 값을 크게 올려 올 때 말로 내려가는 폭: ${steps}.${more} 같은 값을 되풀이하면 내려가지 않습니다.`;
    } catch (err) {
      preview.textContent = `${err.message} 새 품목은 저장한 뒤에 볼 수 있습니다.`;
    }
  };

  const tierRows = h('div', { class: 'tiers' });
  const drawTiers = () => {
    tierRows.replaceChildren(
      ...(product.tiers || []).map((tier, i) =>
        h(
          'div',
          { class: 'row' },
          field('수량 이상', tier, 'minQty', { type: 'number' }),
          field('할인 %', tier, 'pct', { type: 'number' }),
          h(
            'button',
            {
              class: 'link',
              type: 'button',
              onclick() {
                product.tiers.splice(i, 1);
                drawTiers();
              },
            },
            '삭제',
          ),
        ),
      ),
    );
  };
  drawTiers();

  return h(
    'article',
    { class: 'item product', oninput: paintRange },
    h(
      'div',
      { class: 'item-head' },
      h('strong', null, product.name || '새 품목'),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: product.active !== false,
          onchange(event) {
            product.active = event.target.checked;
          },
        }),
        h('span', null, '판매 중'),
      ),
    ),
    h('h3', null, '흥정 기준'),
    h(
      'div',
      { class: 'grid' },
      field('정가(원)', product, 'list', { type: 'number', hint: '처음 보여 주는 단가' }),
      field('적정가(원)', product, 'target', { type: 'number', cls: 'secret', hint: '말로 하는 흥정은 여기까지. 밑으로는 수량이나 조건을 받아야 내려갑니다' }),
      field('절대 하한가(원)', product, 'floor', { type: 'number', cls: 'secret', hint: '이 밑으로는 어떤 조건에도 합의하지 않습니다' }),
      choice('양보 속도', product, 'pace', [['', '기본 규칙 따름'], ...Object.entries(paces).map(([id, p]) => [id, p.label])]),
      choice('합의 전 되받기', product, 'minRounds', [['', '기본 규칙 따름'], [0, '바로 합의'], [1, '1번'], [2, '2번'], [3, '3번'], [4, '4번'], [5, '5번']]),
    ),
    range,
    h(
      'details',
      { open: !product.id },
      h('summary', null, '품목 정보·수량 할인'),
    h(
      'div',
      { class: 'grid' },
      field('품목 코드', product, 'id', { hint: '영문·숫자' }),
      field('품목명', product, 'name', { cls: 'span2' }),
      field('규격', product, 'spec', { cls: 'span2' }),
      field('단위', product, 'unit'),
      field('최소 주문', product, 'moq', { type: 'number' }),
      field('재고', product, 'stock', { type: 'number' }),
      field('재고 납기(일)', product, 'leadDays', { type: 'number' }),
      field('생산 납기(일)', product, 'makeDays', { type: 'number' }),
      field('AI가 안내해도 되는 메모', product, 'note', { cls: 'span3' }),
    ),
    h('h3', null, '수량 할인'),
    tierRows,
    h(
      'button',
      {
        class: 'link',
        type: 'button',
        onclick() {
          (product.tiers ||= []).push({ minQty: 0, pct: 0 });
          drawTiers();
        },
      },
      '+ 구간 추가',
    ),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'link', type: 'button', onclick: showPreview }, '저장된 값으로 흥정 미리보기'),
      h(
        'button',
        {
          class: 'link danger',
          type: 'button',
          onclick() {
            if (!confirm(`${product.name || '이 품목'}을(를) 지울까요? 저장을 눌러야 반영됩니다.`)) return;
            settings.products.splice(settings.products.indexOf(product), 1);
            draw();
          },
        },
        '품목 삭제',
      ),
    ),
    preview,
  );
}

// 품목이 많으면 폼이 너무 길어져서 한 줄로 두고, 펼칠 때 폼을 만든다.
function productRow(product) {
  const title = h('strong', { class: 'clip' });
  const line = h('span', { class: 'sub clip' });
  const paint = () => {
    title.textContent = product.name || '새 품목';
    const aim = product.target > 0 ? ` · 적정가 ${won(product.target)}` : '';
    line.textContent = `정가 ${won(product.list || 0)}${aim} · 하한 ${won(product.floor || 0)} · 최소 ${product.moq}${product.unit}`;
  };
  paint();
  let filled = false;
  const row = h(
    'details',
    {
      class: 'item fold product-row',
      open: !product.id,
      oninput: paint,
      ontoggle() {
        if (!row.open || filled) return;
        filled = true;
        row.append(productForm(product));
      },
    },
    h(
      'summary',
      null,
      h('span', { class: 'item-head' }, title, product.active === false && h('span', { class: 'tag' }, '판매 중지')),
      line,
    ),
  );
  return row;
}

const IMPORT_COLUMNS = '품목명, 규격, 단위, 정가, 적정가, 절대 하한가, 최소 주문, 재고, 재고 납기(일), 생산 납기(일)';
const toNumber = (text) => Number(String(text ?? '').replace(/[^\d.]/g, ''));

function productFromRow([name, spec, unit, list, target, floor, moq, stock, leadDays, makeDays], id) {
  return {
    id, name, spec: spec || '', unit: unit || '개',
    list: toNumber(list), target: toNumber(target), floor: toNumber(floor),
    moq: toNumber(moq) || 1, stock: toNumber(stock),
    leadDays: toNumber(leadDays) || 3, makeDays: toNumber(makeDays) || 14, tiers: [], note: '', active: true,
  };
}

function nextProductId(taken) {
  let n = taken.size + 1;
  while (taken.has(`P${String(n).padStart(3, '0')}`)) n += 1;
  const id = `P${String(n).padStart(3, '0')}`;
  taken.add(id);
  return id;
}

// 엑셀에서 복사한 칸은 탭으로 나뉘어 들어온다. 제목 줄처럼 정가가 숫자가 아닌 줄은 건너뛴다.
function importBox(status) {
  const box = h('textarea', { rows: 4, placeholder: IMPORT_COLUMNS, 'aria-label': '엑셀 붙여넣기' });
  const add = () => {
    const rows = box.value.split('\n').map((line) => line.split('\t').map((cell) => cell.trim())).filter((cells) => toNumber(cells[3]) > 0);
    if (rows.length === 0) {
      status.textContent = '읽을 수 있는 줄이 없습니다. 칸 순서를 확인해 주세요.';
      return;
    }
    const taken = new Set(settings.products.map((p) => p.id));
    for (const cells of rows) settings.products.push(productFromRow(cells, nextProductId(taken)));
    drawProducts(`${rows.length}개 품목을 아래에 넣었습니다. 맨 아래 저장을 눌러야 반영됩니다.`);
  };
  return h(
    'details',
    { class: 'form-card' },
    h('summary', null, '엑셀에서 한 번에 넣기'),
    h('p', { class: 'sub' }, `엑셀에서 아래 순서의 칸을 복사해 붙여 넣으세요. ${IMPORT_COLUMNS}`),
    box,
    h('button', { class: 'ghost', type: 'button', onclick: add }, '품목 추가'),
  );
}

function drawProducts(note = '') {
  const status = h('p', { class: 'path', role: 'status' }, note);
  const hasSample = settings.products.some(isSample);
  const rows = settings.products.map((product) => ({ product, row: productRow(product) }));
  const filterRows = () => {
    const word = productSearch.trim().toLowerCase();
    for (const { product, row } of rows) {
      row.hidden = !`${product.name} ${product.id} ${product.spec}`.toLowerCase().includes(word);
    }
  };
  filterRows();
  main.replaceChildren(
    h('h1', null, `품목·가격 ${settings.products.length}개`),
    h('p', { class: 'sub' }, '적정가와 절대 하한가는 서버의 가격 계산에만 쓰입니다. AI도 구매자도 볼 수 없습니다. 수량 할인이나 조건을 붙여도 절대 하한가 밑으로는 내려가지 않습니다.'),
    importBox(status),
    ...(hasSample
      ? [
          h(
            'button',
            {
              class: 'link danger',
              type: 'button',
              onclick() {
                if (!confirm('예시 품목을 모두 지울까요? 저장을 눌러야 반영됩니다.')) return;
                settings.products = settings.products.filter((p) => !isSample(p));
                drawProducts('예시 품목을 지웠습니다. 맨 아래 저장을 눌러야 반영됩니다.');
              },
            },
            '예시 품목 모두 지우기',
          ),
        ]
      : []),
    status,
    h('input', {
      class: 'search',
      type: 'search',
      value: productSearch,
      placeholder: '품목명, 코드, 규격 검색',
      'aria-label': '품목 검색',
      oninput(event) {
        productSearch = event.target.value;
        filterRows();
      },
    }),
    h('div', { class: 'list' }, rows.map(({ row }) => row)),
    h(
      'button',
      {
        class: 'ghost',
        type: 'button',
        onclick() {
          settings.products.push({
            id: '', name: '', spec: '', unit: '개', list: 0, target: 0, floor: 0, moq: 1,
            stock: 0, leadDays: 3, makeDays: 14, tiers: [], note: '', active: true,
          });
          productSearch = '';
          draw();
          main.querySelector('.product-row[open]')?.scrollIntoView({ block: 'center' });
        },
      },
      '+ 품목 추가',
    ),
    saveBar(),
  );
}

const lines = (object, key, label, hint) => {
  const control = h('textarea', {
    rows: 4,
    value: (object[key] || []).join('\n'),
    oninput(event) {
      object[key] = event.target.value.split('\n').map((v) => v.trim()).filter(Boolean);
    },
  });
  return h('label', null, label, control, hint && h('small', null, hint));
};

function faqForm(faq, i) {
  return h(
    'article',
    { class: 'item' },
    field('질문', faq, 'q'),
    field('답변', faq, 'a', { rows: 2 }),
    h(
      'button',
      {
        class: 'link danger',
        type: 'button',
        onclick() {
          settings.faqs.splice(i, 1);
          draw();
        },
      },
      '삭제',
    ),
  );
}

function drawCompany() {
  const { company, policies } = settings;
  main.replaceChildren(
    h('h1', null, '회사·정책'),
    h('p', { class: 'sub' }, '여기 적은 내용은 전부 AI가 구매자에게 말할 수 있습니다. 내부 정보는 적지 마세요.'),
    h(
      'div',
      { class: 'form-card' },
      h(
        'div',
        { class: 'grid' },
        field('회사 이름', company, 'name', { cls: 'span3' }),
        field('한 줄 소개', company, 'intro', { cls: 'span3' }),
        field('전화', company, 'phone'),
        field('이메일', company, 'email'),
        field('운영 시간', company, 'hours'),
        field('주소', company, 'address', { cls: 'span3' }),
        field('개인정보 담당자', company, 'privacyOfficer', { cls: 'span3', hint: '개인정보 처리방침에 표시됩니다. 예: 대표 홍길동' }),
      ),
      field('첫인사', settings, 'greeting', { rows: 2 }),
      lines(settings, 'quickQuestions', '바로 누를 수 있는 질문', '한 줄에 하나씩'),
    ),
    h('h2', null, '거래 정책'),
    h(
      'div',
      { class: 'form-card' },
      field('결제', policies, 'payment', { rows: 2 }),
      field('세금', policies, 'tax', { rows: 2 }),
      field('배송', policies, 'delivery', { rows: 2 }),
      field('교환·반품', policies, 'returns', { rows: 2 }),
      field('제공 서류', policies, 'documents', { rows: 2 }),
    ),
    h('h2', null, '자주 묻는 질문'),
    ...settings.faqs.map(faqForm),
    h(
      'button',
      {
        class: 'ghost',
        type: 'button',
        onclick() {
          settings.faqs.push({ q: '', a: '' });
          draw();
        },
      },
      '+ 질문 추가',
    ),
    saveBar(),
  );
}

function conditionForm(condition, i) {
  return h(
    'div',
    { class: 'row cond' },
    field('조건 이름', condition, 'name', { cls: 'grow' }),
    field('추가 할인 %', condition, 'pct', { type: 'number' }),
    h(
      'button',
      {
        class: 'link danger',
        type: 'button',
        onclick() {
          settings.conditions.splice(i, 1);
          draw();
        },
      },
      '삭제',
    ),
  );
}

function drawRules() {
  settings.negotiation.minRounds ??= 2;
  const pace = h(
    'select',
    {
      onchange(event) {
        settings.negotiation.pace = event.target.value;
      },
    },
    Object.entries(paces).map(([id, p]) =>
      h('option', { value: id, selected: id === settings.negotiation.pace }, p.label),
    ),
  );
  main.replaceChildren(
    h('h1', null, '흥정 규칙'),
    h('p', { class: 'sub' }, '모든 품목의 기본값입니다. 품목마다 다르게 하려면 품목·가격 탭에서 바꿉니다.'),
    h(
      'div',
      { class: 'form-card' },
      h('label', null, '양보 속도', pace, h('small', null, '구매자가 희망가를 올려 올 때 한 번에 내려가는 폭입니다. 구매자가 올린 금액보다 많이 내리지 않고, 말로는 적정가까지만 내려갑니다. 같은 값을 되풀이하면 내려가지 않습니다.')),
      field('단가 단위(원)', settings.negotiation, 'roundUnit', { type: 'number', hint: '제시 단가를 이 단위로 올림합니다.' }),
      field('합의 전 되받기 횟수', settings.negotiation, 'minRounds', { type: 'number', hint: '희망가가 받아 줄 만해도 이 횟수만큼은 사이값으로 되받은 뒤에 합의합니다. 0이면 바로 합의합니다.' }),
    ),
    h('h2', null, '가격을 낮춰 주는 조건'),
    h('p', { class: 'sub' }, '구매자가 받아들이면 시작가와 적정가가 함께 내려갑니다. 적정가 밑으로 내려가는 길은 이 조건과 수량 할인뿐입니다. 절대 하한가는 내려가지 않습니다.'),
    h(
      'div',
      { class: 'form-card' },
      settings.conditions.map(conditionForm),
      h(
        'button',
        {
          class: 'link',
          type: 'button',
          onclick() {
            settings.conditions.push({ id: `c${Date.now()}`, name: '', pct: 1 });
            draw();
          },
        },
        '+ 조건 추가',
      ),
    ),
    h('h2', null, '비용 한도'),
    h(
      'div',
      { class: 'form-card grid' },
      field('하루 AI 응답 수', settings.limits, 'dailyMessages', { type: 'number', hint: '넘으면 담당자 응대로 넘깁니다.' }),
      field('상담 한 건당 메시지 수', settings.limits, 'chatMessages', { type: 'number' }),
    ),
    saveBar(),
  );
}

const pushKeyBytes = (key) =>
  Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

function phoneGuide() {
  const qr = h('div', { class: 'qr' });
  const showQr = async () => {
    try {
      await new Promise((resolve, reject) => {
        if (window.qrcode) resolve();
        else document.head.append(h('script', { src: QR_SCRIPT, onload: resolve, onerror: reject }));
      });
      const code = window.qrcode(0, 'M');
      code.addData(`${location.origin}${location.pathname}#t=${token}`);
      code.make();
      qr.replaceChildren(
        h('img', { src: code.createDataURL(5, 10), alt: '관리 화면 QR 코드' }),
        h('p', { class: 'sub' }, '이 QR에는 관리 비밀번호가 들어 있습니다. 다른 사람에게 보이지 마세요.'),
      );
    } catch {
      qr.replaceChildren(h('p', { class: 'note error' }, 'QR을 불러오지 못했습니다.'));
    }
  };
  return h(
    'div',
    { class: 'form-card' },
    h('button', { class: 'ghost', type: 'button', onclick: showQr }, 'QR 코드 보기'),
    qr,
    h('p', { class: 'sub' }, '안드로이드: QR을 찍어 관리 화면을 열고, 알림 탭에서 알림 켜기를 누릅니다.'),
    h('p', { class: 'sub' }, '아이폰: QR을 찍어 사파리로 열고, 공유 버튼에서 홈 화면에 추가를 누릅니다. 홈 화면 아이콘으로 다시 열어 관리 비밀번호를 넣은 뒤 알림 켜기를 누릅니다.'),
    h(
      'button',
      {
        class: 'link',
        type: 'button',
        async onclick(event) {
          await navigator.clipboard.writeText(token);
          event.target.textContent = '복사했습니다';
        },
      },
      '관리 비밀번호 복사',
    ),
  );
}

async function drawAlerts() {
  const { publicKey, devices } = await call('/admin/push');
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  const registration = supported ? await navigator.serviceWorker.getRegistration() : null;
  const subscription = (await registration?.pushManager.getSubscription()) ?? null;
  const status = h('p', { class: 'sub', role: 'status' });
  const guarded = (run) => async () => {
    try {
      await run();
    } catch (err) {
      status.textContent = err.message;
    }
  };

  const enable = guarded(async () => {
    if ((await Notification.requestPermission()) !== 'granted') {
      status.textContent = '브라우저에서 알림이 차단되어 있습니다. 주소창의 사이트 설정에서 알림을 허용해 주세요.';
      return;
    }
    const worker = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const created = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(publicKey) });
    await call('/admin/push', { method: 'POST', body: { subscription: created.toJSON() } });
    draw();
  });
  const disable = guarded(async () => {
    await subscription.unsubscribe();
    await call('/admin/push/remove', { method: 'POST', body: { endpoint: subscription.endpoint } });
    draw();
  });
  const test = guarded(async () => {
    const { sent } = await call('/admin/push/test', { method: 'POST', body: {} });
    status.textContent = `${sent}대의 기기로 시험 알림을 보냈습니다.`;
  });

  const controls = subscription
    ? [
        h('button', { class: 'primary', type: 'button', onclick: test }, '시험 알림 보내기'),
        h('button', { class: 'ghost', type: 'button', onclick: disable }, '이 기기 알림 끄기'),
      ]
    : [h('button', { class: 'primary', type: 'button', disabled: !supported, onclick: enable }, '이 기기에서 알림 켜기')];

  main.replaceChildren(
    h('h1', null, '알림'),
    h('p', { class: 'sub' }, '견적 요청, 담당자 연결 요청, AI가 답하지 못한 질문이 들어오면 켜 둔 기기로 바로 알립니다.'),
    h(
      'div',
      { class: 'form-card' },
      h('p', null, `이 기기: ${subscription ? '알림 켜짐' : '알림 꺼짐'} · 알림 받는 기기 ${devices}대`),
      !supported && h('p', { class: 'sub' }, '이 브라우저에서는 알림을 쓸 수 없습니다. 아이폰은 아래 안내대로 홈 화면에 추가해 주세요.'),
      h('div', { class: 'row' }, controls),
      status,
    ),
    h('h2', null, '휴대폰에서 받기'),
    phoneGuide(),
  );
}

async function draw() {
  try {
    if (tab === 'today') await drawToday();
    else if (tab === 'chats' && openChatId) await drawChat(openChatId);
    else if (tab === 'chats') await drawChatList();
    else if (tab === 'products') drawProducts();
    else if (tab === 'company') drawCompany();
    else if (tab === 'alerts') await drawAlerts();
    else drawRules();
  } catch (err) {
    if (err.status === 401) {
      memory.remove(TOKEN_KEY);
      showLogin(err.message);
    } else {
      main.replaceChildren(h('p', { class: 'note error' }, err.message));
    }
  }
}

function editing() {
  const el = document.activeElement;
  if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  // 쓰다 만 답변이 있으면 화면을 다시 그려 지우지 않는다.
  return [...main.querySelectorAll('.item input:not([type=checkbox]), .item textarea, .staff-reply textarea')].some((box) => box.value);
}

async function start() {
  if (!token) {
    showLogin();
    return;
  }
  app.replaceChildren(loadingView('관리 화면을 불러오는 중입니다…'));
  try {
    ({ settings, paces } = await call('/admin/settings', { timeoutMs: LOAD_TIMEOUT_MS }));
  } catch (err) {
    // 비밀번호가 틀렸을 때만 지운다. 연결이 안 될 때는 비밀번호를 남기고 다시 시도하게 한다.
    if (err.status === 401) {
      memory.remove(TOKEN_KEY);
      token = null;
      showLogin(err.message);
    } else {
      app.replaceChildren(retryView(err.message, start));
    }
    return;
  }
  nav = h('nav', { class: 'tabs' });
  main = h('main', { class: 'pane' });
  app.replaceChildren(
    h(
      'div',
      { class: 'admin' },
      h(
        'header',
        { class: 'top' },
        h('div', { class: 'brand' }, h('strong', null, settings.company.name), h('span', { class: 'tag' }, '관리')),
        h('a', { class: 'ghost-link', href: 'index.html', target: '_blank', rel: 'noopener' }, '상담 화면 열기'),
      ),
      nav,
      main,
    ),
  );
  drawNav();
  draw();
  setInterval(() => {
    const live = tab === 'today' || tab === 'chats';
    if (live && !document.hidden && !editing()) draw();
  }, POLL_MS);
}

takeTokenFromLink();
start();
