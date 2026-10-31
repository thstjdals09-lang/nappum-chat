export const API = window.NAPPUM_API || '/api';

// 입력값은 전부 글자로 넣는다. innerHTML을 쓰지 말 것.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const won = (value) => `${Number(value).toLocaleString('ko-KR')}원`;

export function clock(iso) {
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || '요청을 처리하지 못했습니다.'), { status: res.status });
  }
  return data;
}

export const memory = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 저장이 막힌 브라우저에서는 새로고침 때 다시 입력하면 된다.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 위와 같다.
    }
  },
};

const OFFER_STATUS = {
  quote: ['제시 단가', ''],
  counter: ['조정 제시', ''],
  final: ['최종 제시', 'warn'],
  accept: ['합의 가능', 'good'],
};

const QUOTE_STATUS = {
  pending: ['담당자 검토 중', 'warn'],
  approved: ['승인됨', 'good'],
  rejected: ['반려됨', 'bad'],
};

export const tag = ([label, tone]) => h('span', { class: `tag ${tone}` }, label);
export const quoteTag = (status) => tag(QUOTE_STATUS[status] || [status, '']);

export function offerCard(card, action) {
  const row = (label, value, cls) =>
    h('div', { class: `slip-row ${cls || ''}` }, h('span', null, label), h('b', null, value));
  return h(
    'div',
    { class: 'slip' },
    h(
      'div',
      { class: 'slip-head' },
      h('strong', null, card.name),
      tag(OFFER_STATUS[card.status] || OFFER_STATUS.quote),
    ),
    h(
      'p',
      { class: 'slip-sub' },
      `${card.qty.toLocaleString('ko-KR')}${card.unit} · ${card.inStock ? '재고 있음' : '생산 후 출고'} · 납기 약 ${card.leadDays}일`,
    ),
    h(
      'div',
      { class: 'slip-price' },
      h('span', null, won(card.unitPrice)),
      card.unitPrice < card.listPrice && h('s', null, won(card.listPrice)),
    ),
    card.conditions.length > 0 && h('p', { class: 'slip-sub' }, `적용 조건: ${card.conditions.join(', ')}`),
    row('공급가액', won(card.supply)),
    row('부가세', won(card.vat)),
    row('합계', won(card.total), 'total'),
    action,
  );
}

export function quoteCard(card) {
  return h(
    'div',
    { class: 'slip' },
    h('div', { class: 'slip-head' }, h('strong', null, `견적 ${card.no}`), quoteTag(card.status)),
    card.items.map((item) =>
      h('p', { class: 'slip-sub' }, `${item.name} ${item.qty.toLocaleString('ko-KR')}${item.unit} × ${won(item.unitPrice)}`),
    ),
    h('div', { class: 'slip-row total' }, h('span', null, '합계(부가세 포함)'), h('b', null, won(card.total))),
  );
}

export function bubble(message) {
  const labels = { agent: 'AI 상담원', staff: '담당자' };
  if (message.role === 'system') return h('p', { class: 'note' }, message.text);
  return h(
    'div',
    { class: `msg ${message.role}` },
    labels[message.role] && h('span', { class: 'who' }, labels[message.role]),
    h('div', { class: 'bubble' }, message.text),
  );
}
