import { bubble, clock, h, memory, offerCard, quoteTag, request, won } from './common.js';

const TOKEN_KEY = 'nappum.admin';
const POLL_MS = 8000;

const app = document.getElementById('app');
const TABS = [
  ['today', '오늘 할 일'],
  ['chats', '상담'],
  ['products', '품목·가격'],
  ['company', '회사·정책'],
  ['rules', '흥정 규칙'],
];

let token = memory.get(TOKEN_KEY);
let tab = 'today';
let openChatId = null;
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

function quoteRow(quote) {
  const memo = h('input', { placeholder: '구매자에게 전할 말(선택)', maxLength: 300 });
  const decide = async (status) => {
    try {
      await call(`/admin/quotes/${quote.id}`, { method: 'POST', body: { status, note: memo.value } });
      draw();
    } catch (err) {
      alert(err.message);
    }
  };
  return h(
    'article',
    { class: 'item' },
    h(
      'div',
      { class: 'item-head' },
      h('strong', null, quote.buyer.company),
      h('span', { class: 'sub' }, `${quote.no} · ${clock(quote.createdAt)}`),
    ),
    h('p', { class: 'sub' }, `${quote.buyer.name} · ${quote.buyer.phone}`),
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
  return h(
    'article',
    { class: 'item' },
    h(
      'div',
      { class: 'item-head' },
      h('strong', null, ticket.company),
      h('span', { class: 'tag warn' }, ticket.label),
    ),
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

async function drawToday() {
  const data = await call('/admin/overview');
  const limit = settings?.limits?.dailyMessages;
  main.replaceChildren(
    h('h1', null, '오늘 할 일'),
    h(
      'div',
      { class: 'tiles' },
      tile('승인 대기 견적', data.quotes.length),
      tile('처리할 요청', data.tickets.length),
      tile('오늘 AI 응답', data.usage.messages, limit ? `하루 한도 ${limit}회` : null),
      tile('오늘 AI 비용', `약 $${data.usage.costUsd.toFixed(2)}`, '토큰 사용량 기준 추정'),
    ),
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
  );
}

function openChat(id) {
  tab = 'chats';
  openChatId = id;
  drawNav();
  draw();
}

async function drawChatList() {
  const { chats } = await call('/admin/overview');
  main.replaceChildren(
    h('h1', null, '상담'),
    chats.length
      ? h(
          'div',
          { class: 'list' },
          chats.map((chat) =>
            h(
              'button',
              { class: 'list-row', type: 'button', onclick: () => openChat(chat.id) },
              h(
                'span',
                { class: 'item-head' },
                h('strong', null, chat.buyer.company),
                h('span', { class: `tag ${chat.mode === 'human' ? 'good' : ''}` }, chat.mode === 'human' ? '담당자' : 'AI'),
              ),
              h('span', { class: 'sub' }, `${chat.buyer.name} · ${chat.messages}개 메시지 · ${clock(chat.updatedAt)}`),
              h('span', { class: 'sub clip' }, chat.lastText || '아직 메시지가 없습니다.'),
            ),
          ),
        )
      : h('p', { class: 'empty' }, '아직 들어온 상담이 없습니다.'),
  );
}

async function drawChat(id) {
  const chat = await call(`/admin/chats/${id}`);
  const log = h('div', { class: 'log static' });
  for (const message of chat.messages) {
    log.append(bubble(message));
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
                neg.floor != null && h('p', { class: 'sub' }, `최저 허용가 ${won(neg.floor)}`),
              ),
            )
          : h('p', { class: 'empty' }, '아직 흥정이 없습니다.'),
        h('h2', null, '견적'),
        chat.quotes.length
          ? chat.quotes.map((q) =>
              h('div', { class: 'item' }, h('div', { class: 'item-head' }, h('strong', null, q.no), quoteTag(q.status)), h('p', null, won(q.total))),
            )
          : h('p', { class: 'empty' }, '아직 견적이 없습니다.'),
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
  const showPreview = async () => {
    try {
      const data = await call('/admin/preview', {
        method: 'POST',
        body: { productId: product.id, qty: product.moq },
      });
      preview.textContent = `최소 수량 기준, 낮게 계속 부를 때: ${data.path.map((p) => won(p.price)).join(' → ')}`;
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
    { class: 'item product' },
    h(
      'div',
      { class: 'grid' },
      field('품목 코드', product, 'id', { hint: '영문·숫자' }),
      field('품목명', product, 'name', { cls: 'span2' }),
      field('규격', product, 'spec', { cls: 'span2' }),
      field('단위', product, 'unit'),
      field('정가(원)', product, 'list', { type: 'number' }),
      field('최저 허용가(원)', product, 'floor', { type: 'number', cls: 'secret', hint: 'AI도 구매자도 볼 수 없습니다' }),
      field('최소 주문', product, 'moq', { type: 'number' }),
      field('재고', product, 'stock', { type: 'number' }),
      field('재고 납기(일)', product, 'leadDays', { type: 'number' }),
      field('생산 납기(일)', product, 'makeDays', { type: 'number' }),
      field('AI가 안내해도 되는 메모', product, 'note', { cls: 'span3' }),
    ),
    h('h3', null, '수량 할인'),
    tierRows,
    h(
      'div',
      { class: 'row' },
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

function drawProducts() {
  main.replaceChildren(
    h('h1', null, '품목·가격'),
    h('p', { class: 'sub' }, '최저 허용가는 서버의 가격 계산에만 쓰입니다. AI가 받는 자료에는 들어가지 않습니다.'),
    ...settings.products.map(productForm),
    h(
      'button',
      {
        class: 'ghost',
        type: 'button',
        onclick() {
          settings.products.push({
            id: '', name: '', spec: '', unit: '개', list: 0, floor: 0, moq: 1,
            stock: 0, leadDays: 3, makeDays: 14, tiers: [], note: '', active: true,
          });
          draw();
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
  const pace = h(
    'select',
    {
      onchange(event) {
        settings.negotiation.pace = event.target.value;
      },
    },
    Object.entries(paces).map(([id, p]) =>
      h('option', { value: id, selected: id === settings.negotiation.pace }, `${p.label} (${p.steps.length}번에 최저가 도달)`),
    ),
  );
  main.replaceChildren(
    h('h1', null, '흥정 규칙'),
    h(
      'div',
      { class: 'form-card' },
      h('label', null, '양보 속도', pace, h('small', null, '구매자가 희망가를 부를 때마다 최저 허용가 쪽으로 다가가는 속도입니다.')),
      field('단가 단위(원)', settings.negotiation, 'roundUnit', { type: 'number', hint: '제시 단가를 이 단위로 올림합니다.' }),
    ),
    h('h2', null, '가격을 낮춰 주는 조건'),
    h('p', { class: 'sub' }, '구매자가 받아들이면 제시가와 최저 허용가가 함께 내려갑니다. 단순히 깎아 주는 대신 무언가를 받고 내려 주는 장치입니다.'),
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

async function draw() {
  try {
    if (tab === 'today') await drawToday();
    else if (tab === 'chats' && openChatId) await drawChat(openChatId);
    else if (tab === 'chats') await drawChatList();
    else if (tab === 'products') drawProducts();
    else if (tab === 'company') drawCompany();
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
  return el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

async function start() {
  if (!token) {
    showLogin();
    return;
  }
  try {
    ({ settings, paces } = await call('/admin/settings'));
  } catch (err) {
    memory.remove(TOKEN_KEY);
    token = null;
    showLogin(err.status === 401 ? err.message : `서버에 연결하지 못했습니다. ${err.message}`);
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
