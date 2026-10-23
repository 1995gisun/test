// 데모 쇼핑몰 "롯데마켓 데모" 공통 스크립트.
// 일부러 심어 둔 사용성 함정은 TRAPS.md 참고.

const PRODUCTS = [
  { id: 'p1', name: '제주 삼다수 2L x 6병', price: 6480, img: '💧', tags: ['삼다수'] },
  { id: 'p2', name: '아이시스 8.0 500ml x 20병', price: 9900, img: '💧', tags: ['아이시스'] },
  { id: 'p3', name: '신라면 멀티팩 5입', price: 4380, img: '🍜', tags: ['신라면', '라면'] },
  { id: 'p4', name: '햇반 210g x 12개', price: 13900, img: '🍚', tags: ['햇반', '즉석밥'] },
  { id: 'p5', name: '캠핑용 일회용 그릴 세트', price: 8900, img: '🔥', tags: ['캠핑', '그릴'] },
  { id: 'p6', name: '1++ 한우 등심 300g', price: 32900, img: '🥩', tags: ['한우', '소고기'] },
];

const COUPON = { code: 'WELCOME3000', amount: 3000, min: 5000 };

function loadCart() {
  try { return JSON.parse(localStorage.getItem('cart') || '[]'); } catch { return []; }
}
function saveCart(cart) { localStorage.setItem('cart', JSON.stringify(cart)); }
function addToCart(id, qty) {
  const cart = loadCart();
  const line = cart.find((l) => l.id === id);
  if (line) line.qty += qty; else cart.push({ id, qty });
  saveCart(cart);
}
function cartCount() { return loadCart().reduce((n, l) => n + l.qty, 0); }
function won(n) { return n.toLocaleString('ko-KR') + '원'; }
function product(id) { return PRODUCTS.find((p) => p.id === id); }

// 함정: 검색은 상품명/태그에 검색어가 그대로 들어 있어야만 찾는다. "물", "생수", "water"로는 삼다수가 안 나온다.
function search(q) {
  q = q.trim();
  if (!q) return PRODUCTS;
  return PRODUCTS.filter((p) => p.name.includes(q) || p.tags.includes(q));
}

function renderHeader() {
  const el = document.getElementById('header');
  if (!el) return;
  // 함정: 장바구니 아이콘은 button/a가 아닌 div + onclick이고 텍스트도 aria-label도 없다.
  el.innerHTML = `
    <a class="logo" href="index.html">롯데마켓<small>DEMO</small></a>
    <form class="search" onsubmit="event.preventDefault(); location.href='index.html?q='+encodeURIComponent(this.q.value)">
      <input name="q" placeholder="검색어 입력" />
      <button>검색</button>
    </form>
    <div class="cart-icon" onclick="location.href='cart.html'">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>
      <span class="badge">${cartCount() || ''}</span>
    </div>`;
}

// 함정: 첫 방문 팝업. 닫기 버튼은 작고 흐린 "×" 하나뿐이며 접근 가능한 이름이 없다.
function maybePopup() {
  if (sessionStorage.getItem('popupSeen')) return;
  const wrap = document.createElement('div');
  wrap.className = 'popup-dim';
  wrap.innerHTML = `
    <div class="popup">
      <span class="popup-x" onclick="this.closest('.popup-dim').remove(); sessionStorage.setItem('popupSeen','1')">×</span>
      <h2>🎉 신규회원 웰컴 혜택</h2>
      <p>지금 가입하면 앱 전용 쿠폰팩 증정!</p>
      <a class="btn" href="#" onclick="event.preventDefault()">앱 다운로드하고 혜택받기</a>
    </div>`;
  document.body.appendChild(wrap);
}

document.addEventListener('DOMContentLoaded', renderHeader);
