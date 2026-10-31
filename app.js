import { bubble, h, memory, offerCard, quoteCard, quoteTag, request, won } from './common.js';

const SESSION_KEY = 'nappum.session';
const POLL_MS = 5000;

const app = document.getElementById('app');
let info;
let session = memory.get(SESSION_KEY);
let lastSeq = 0;
let sending = false;
let view = { mode: 'ai', offers: [], quotes: [] };
const ui = {};
const actions = new Map();

const auth = () => ({ 'x-chat-token': session.token });

function showEntry(error) {
  const fields = {
    company: h('input', { required: true, maxLength: 60, autocomplete: 'organization', placeholder: '예: 가나공업' }),
    name: h('input', { required: true, maxLength: 30, autocomplete: 'name', placeholder: '구매 담당자 성함' }),
    phone: h('input', { required: true, maxLength: 30, type: 'tel', autocomplete: 'tel', placeholder: '010-0000-0000' }),
    consent: h('input', { type: 'checkbox', required: true }),
  };
  const alert = h('p', { class: 'form-error', role: 'alert' }, error || '');

  async function start(event) {
    event.preventDefault();
    alert.textContent = '';
    try {
      session = await request('/chats', {
        method: 'POST',
        body: {
          company: fields.company.value,
          name: fields.name.value,
          phone: fields.phone.value,
          consent: fields.consent.checked,
        },
      });
      memory.set(SESSION_KEY, session);
      showChat();
    } catch (err) {
      alert.textContent = err.message;
    }
  }

  app.replaceChildren(
    h(
      'main',
      { class: 'entry' },
      h(
        'section',
        { class: 'entry-card' },
        h('p', { class: 'eyebrow' }, 'AI 납품 상담'),
        h('h1', null, info.company.name),
        h('p', { class: 'lead' }, info.company.intro),
        h(
          'form',
          { onsubmit: start },
          h('label', null, '회사명', fields.company),
          h('label', null, '담당자', fields.name),
          h('label', null, '연락처', fields.phone),
          h(
            'label',
            { class: 'check' },
            fields.consent,
            h(
              'span',
              null,
              'AI 상담원이 응대하는 데 동의합니다. 상담 내용은 응대 기록으로 저장되고 답변을 만들기 위해 AI 서비스(Anthropic)로 전달됩니다. 이름과 연락처는 납품 상담에만 씁니다.',
            ),
          ),
          alert,
          h('button', { class: 'primary wide', type: 'submit' }, '상담 시작'),
        ),
      ),
    ),
  );
  fields.company.focus();
}

function renderSide() {
  const latestQuote = view.quotes.at(-1);
  ui.offers.replaceChildren(
    ...(view.offers.length
      ? view.offers.map((card) => offerCard(card))
      : [h('p', { class: 'empty' }, '품목과 수량을 말씀해 주시면 여기에 조건이 정리됩니다.')]),
    ...(latestQuote ? [quoteCard({ ...latestQuote })] : []),
  );
  ui.modeTag.textContent = view.mode === 'human' ? '담당자 응대 중' : 'AI 상담원';
  ui.modeTag.className = `tag ${view.mode === 'human' ? 'good' : ''}`;
}

// 지난 가격 카드로 요청하면 안 되므로 품목별 최신 카드에만 버튼을 둔다.
function retireAction(productId) {
  actions.get(productId)?.remove();
  actions.delete(productId);
}

function appendMessage(message) {
  if (message.role === 'buyer') ui.quick.replaceChildren();
  ui.log.append(bubble(message));
  for (const card of message.cards || []) {
    if (card.kind === 'quote') {
      card.items.forEach((item) => retireAction(item.productId));
      ui.log.append(quoteCard(card));
      continue;
    }
    retireAction(card.productId);
    const action = h(
      'button',
      {
        class: 'ghost wide',
        type: 'button',
        onclick: () =>
          send(`${card.name} ${card.qty}${card.unit}, 단가 ${won(card.unitPrice)} 조건으로 견적 요청합니다.`),
      },
      '이 조건으로 견적 요청',
    );
    actions.set(card.productId, action);
    ui.log.append(offerCard(card, action));
  }
}

function absorb(data) {
  view = { mode: data.mode, offers: data.offers, quotes: data.quotes };
  for (const message of data.messages) {
    if (message.seq > lastSeq) {
      appendMessage(message);
      lastSeq = message.seq;
    }
  }
  renderSide();
}

const scrollDown = () => {
  ui.log.scrollTop = ui.log.scrollHeight;
};

async function send(text) {
  const message = text.trim();
  if (!message || sending) return;
  sending = true;
  ui.send.disabled = true;
  ui.quick.replaceChildren();
  ui.input.value = '';

  const pending = h('div', { class: 'msg buyer pending' }, h('div', { class: 'bubble' }, message));
  const typing = h(
    'div',
    { class: 'msg agent typing', 'aria-live': 'polite' },
    h('div', { class: 'bubble' }, h('i'), h('i'), h('i')),
  );
  ui.log.append(pending, typing);
  scrollDown();

  try {
    const data = await request(`/chats/${session.id}/messages`, {
      method: 'POST',
      headers: auth(),
      body: { text: message, after: lastSeq },
    });
    pending.remove();
    typing.remove();
    absorb(data);
  } catch (err) {
    pending.remove();
    typing.remove();
    ui.input.value = message;
    ui.log.append(h('p', { class: 'note error' }, err.message));
  } finally {
    sending = false;
    ui.send.disabled = false;
    scrollDown();
    ui.input.focus();
  }
}

async function poll() {
  if (sending || document.hidden || !session) return;
  try {
    const before = lastSeq;
    absorb(await request(`/chats/${session.id}?after=${lastSeq}`, { headers: auth() }));
    if (lastSeq !== before) scrollDown();
  } catch {
    // 다음 주기에 다시 받는다.
  }
}

async function requestHuman() {
  try {
    absorb(await request(`/chats/${session.id}/handoff?after=${lastSeq}`, { method: 'POST', headers: auth() }));
    scrollDown();
  } catch (err) {
    ui.log.append(h('p', { class: 'note error' }, err.message));
  }
}

function leave() {
  memory.remove(SESSION_KEY);
  session = null;
  lastSeq = 0;
  showEntry();
}

function productList() {
  return info.products.map((p) =>
    h(
      'li',
      null,
      h('strong', null, p.name),
      h('span', null, p.spec),
      h('span', null, `${won(p.list_price)} / ${p.unit} · 최소 ${p.minimum_order}${p.unit}`),
    ),
  );
}

function showChat() {
  actions.clear();
  ui.log = h('div', { class: 'log', 'aria-live': 'polite' });
  ui.input = h('textarea', {
    rows: 1,
    maxLength: 1500,
    placeholder: '품목, 수량, 희망 단가를 적어 주세요',
    'aria-label': '메시지',
    onkeydown(event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send(ui.input.value);
      }
    },
  });
  ui.send = h('button', { class: 'primary', type: 'submit' }, '보내기');
  ui.quick = h(
    'div',
    { class: 'quick' },
    info.quickQuestions.map((q) => h('button', { type: 'button', onclick: () => send(q) }, q)),
  );
  ui.offers = h('div', { class: 'offers' });
  ui.modeTag = h('span', { class: 'tag' }, 'AI 상담원');

  const side = h(
    'aside',
    { class: 'side', id: 'side' },
    h('h2', null, '현재 조건'),
    ui.offers,
    h('h2', null, '취급 품목'),
    h('ul', { class: 'products' }, productList()),
    h('h2', null, '연락처'),
    h(
      'p',
      { class: 'contact' },
      info.company.phone,
      h('br'),
      info.company.email,
      h('br'),
      info.company.hours,
    ),
    h('button', { class: 'link', type: 'button', onclick: leave }, '이 기기에서 상담 닫기'),
  );

  app.replaceChildren(
    h(
      'div',
      { class: 'desk' },
      h(
        'header',
        { class: 'top' },
        h('div', { class: 'brand' }, h('strong', null, info.company.name), ui.modeTag),
        h(
          'div',
          { class: 'top-actions' },
          h(
            'button',
            { class: 'ghost side-toggle', type: 'button', onclick: () => side.classList.toggle('open') },
            '현재 조건',
          ),
          h('button', { class: 'ghost', type: 'button', onclick: requestHuman }, '담당자 연결'),
        ),
      ),
      h(
        'div',
        { class: 'body' },
        h(
          'main',
          { class: 'chat' },
          ui.log,
          ui.quick,
          h(
            'form',
            {
              class: 'composer',
              onsubmit(event) {
                event.preventDefault();
                send(ui.input.value);
              },
            },
            ui.input,
            ui.send,
          ),
          h('p', { class: 'fine' }, 'AI가 안내하는 내용입니다. 납품 조건은 담당자 승인 후 확정됩니다.'),
        ),
        side,
      ),
    ),
  );

  poll().then(scrollDown);
  ui.input.focus();
}

async function boot() {
  try {
    info = await request('/public');
  } catch (err) {
    app.replaceChildren(h('p', { class: 'note error' }, err.message));
    return;
  }
  document.title = `${info.company.name} 납품 상담`;

  if (session) {
    try {
      await request(`/chats/${session.id}?after=999999999`, { headers: auth() });
      showChat();
    } catch {
      memory.remove(SESSION_KEY);
      session = null;
      showEntry('이전 상담을 찾지 못했습니다. 다시 입력해 주세요.');
    }
  } else {
    showEntry();
  }
  setInterval(poll, POLL_MS);
}

boot();
