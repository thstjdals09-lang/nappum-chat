import { request } from './common.js';

// 회사 정보는 관리 화면에서 고친 값을 그대로 보여 준다.
const { company } = await request('/public');
for (const el of document.querySelectorAll('[data-fill]')) {
  const value = company[el.dataset.fill];
  if (value) el.textContent = value;
}
