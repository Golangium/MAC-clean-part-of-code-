console.log(" table.js (v14.3 - Calibrated: Fast Carousel Scroll, Smooth Table Zoom)");

// Глобальная переменная для pinch/drag
let dragData = null;

// Переменные для различения скролла карусели и драга карты
let scrollStartX = 0;
let scrollStartY = 0;
let isScrollingCarousel = false;
let dragDelayTimer = null;
const SCROLL_THRESHOLD = 10; // px - порог горизонтального движения для скролла
const DRAG_DELAY = 150;      // ms - задержка перед началом драга карты

const state = {
    currentDeckId: null,
    deckCards: [],
    tableCards: [],
    activeCard: null,
    drag: { threshold: 15, startX: 0, startY: 0, moved: false },
    ws: null,
    sessionId: window.location.pathname.split('/').pop(),
    allRevealed: false,
    showNumbers: false,
    currentBg: '',
    imageCache: new Map(),
    tableScale: 1,
    tableTranslateX: 0,
    tableTranslateY: 0
};

// ЖЁСТКАЯ ОЧЕРЕДЬ ЗАГРУЗКИ ИЗОБРАЖЕНИЙ
let activeImageLoads = 0;
const MAX_CONCURRENT_LOADS = 3;
const imageLoadQueue = [];

function loadCardImage(innerElement, bgUrl) {
    if (state.imageCache.get(bgUrl)) {
        innerElement.style.backgroundImage = `url(${bgUrl})`;
        return;
    }

    const task = () => {
        activeImageLoads++;
        const img = new Image();
        img.onload = () => {
            innerElement.style.backgroundImage = `url(${bgUrl})`;
            state.imageCache.set(bgUrl, true);
            activeImageLoads--;
            processImageQueue();
        };
        img.onerror = () => {
            state.imageCache.set(bgUrl, false);
            activeImageLoads--;
            processImageQueue();
        };
        img.src = bgUrl;
    };

    if (activeImageLoads < MAX_CONCURRENT_LOADS) {
        task();
    } else {
        imageLoadQueue.push(task);
    }
}

function processImageQueue() {
    if (imageLoadQueue.length > 0 && activeImageLoads < MAX_CONCURRENT_LOADS) {
        const nextTask = imageLoadQueue.shift();
        setTimeout(nextTask, 50);
    }
}

async function checkSiteBlock() {
    try {
        const res = await fetch('/api/decks');
        if (!res.ok && res.status === 503) {
            const data = await res.json();
            if (data.error === 'site_blocked') {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:99999;display:flex;justify-content:center;align-items:center;color:white;font-family:sans-serif;text-align:center;padding:20px;';
                overlay.innerHTML = `<div style="max-width:500px;"><h1 style="font-size:24px;margin-bottom:20px;">🔒 Доступ заблокирован</h1><p style="font-size:18px;line-height:1.5;">${data.message}</p><p style="margin-top:30px;color:#aaa;font-size:14px;">Для разблокировки обращайтесь к администратору.</p></div>`;
                document.body.appendChild(overlay);
                document.body.style.overflow = 'hidden';
                return true;
            }
        }
    } catch (err) { console.log("Проверка статуса блокировки..."); }
    return false;
}

async function initTable() {
    connectWebSocket();
    setupUI();
    setupTableDrag();
    setupTablePan();
}

document.addEventListener('DOMContentLoaded', async () => {
    const isBlocked = await checkSiteBlock();
    if (!isBlocked) await initTable();
});

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.ws = new WebSocket(`${protocol}//${location.host}/ws/${state.sessionId}`);
    state.ws.onopen = () => console.log("🔌 WS connected");
    state.ws.onmessage = (e) => { try { handleServerMessage(JSON.parse(e.data)); } catch(err){} };
    state.ws.onclose = () => console.log(" WS closed");
}

function sendToServer(type, data = {}) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type, ...data }));
}

let hasChanges = false;
setInterval(() => {
    if (hasChanges) {
        sendToServer("state_save", { state: JSON.stringify({
            deckId: state.currentDeckId, revealed: state.allRevealed,
            showNumbers: state.showNumbers, bg: state.currentBg,
            cards: state.tableCards.map(c => ({ id:c.id, x:parseFloat(c.el.style.left)||0, y:parseFloat(c.el.style.top)||0, rot:c.rotation, scale:c.scale, flipped:c.flipped, z:c.zIndex||1 }))
        })});
        hasChanges = false;
    }
}, 5000);

function handleServerMessage(msg) {
    if (msg.type === "init") restoreState(msg.state);
    else if (msg.type === "state_save_ack") return;
    else applyRemoteAction(msg);
}

function applyRemoteAction(msg) {
    switch(msg.type) {
        case "add_card": renderCardOnTable(msg.card); break;
        case "move_card": moveCardLocal(msg.id, msg.x, msg.y); break;
        case "flip_card": flipCardLocal(msg.id, msg.flipped); break;
        case "rotate_card": rotateCardLocal(msg.id, msg.rot); break;
        case "scale_card": scaleCardLocal(msg.id, msg.scale); break;
        case "z_card": zCardLocal(msg.id, msg.z); break;
        case "delete_card": deleteCardLocal(msg.id); break;
        case "clear_table": clearTableLocal(); break;
        case "shuffle_deck": shuffleDeckLocal(msg.order); break;
        case "toggle_revealed": toggleRevealedLocal(msg.revealed); break;
        case "toggle_numbers": toggleNumbersLocal(msg.show); break;
        case "change_background": changeBgLocal(msg.bg); break;
    }
}

function restoreState(dbState) {
    if (!dbState || dbState === "{}") return;
    try {
        const s = typeof dbState === 'string' ? JSON.parse(dbState) : dbState;
        state.currentDeckId = s.deckId;
        state.allRevealed = s.revealed || false;
        state.showNumbers = s.showNumbers || false;
        state.currentBg = s.bg || '';
        changeBgLocal(state.currentBg);
        toggleRevealedLocal(state.allRevealed);
        toggleNumbersLocal(state.showNumbers);
        if (state.currentDeckId) loadDeckFromServer(state.currentDeckId);
        if (s.cards?.length) s.cards.forEach(c => renderCardOnTable(c));
    } catch(e) { console.error("Restore Error:", e); }
}

function setupUI() {
    document.getElementById('btn-bg').disabled = false;
    document.getElementById('btn-decks').onclick = async () => {
        const modal = document.getElementById('decks-modal');
        const list = document.getElementById('decks-list');
        modal.classList.remove('hidden'); list.innerHTML = '<p style="text-align:center; padding:20px;"> Загрузка...</p>';
        try {
            const res = await fetch('/api/decks');
            const decks = await res.json();
            list.innerHTML = '';
            if (!decks.length) { list.innerHTML = '<p style="text-align:center; color:#888;">Колод нет</p>'; return; }
            decks.forEach(d => {
                const div = document.createElement('div');
                div.className = 'deck-item';
                const imgSrc = d.cover_image_url || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150"><rect width="100" height="150" fill="%23ccc" rx="8"/></svg>';
                div.innerHTML = `<img src="${imgSrc}" style="width:100%;border-radius:6px;"><p style="margin-top:8px;font-size:13px">${d.name}</p>`;
                div.onclick = () => loadDeck(d.id, d.name);
                list.appendChild(div);
            });
        } catch(e) { list.innerHTML = '<p style="color:red; text-align:center;">Ошибка</p>'; }
    };
    document.getElementById('btn-shuffle').onclick = () => state.deckCards.length ? shuffleDeck() : alert('Выберите колоду');
    document.getElementById('btn-flip-deck').onclick = () => state.currentDeckId ? toggleDeckVisibility() : alert('Выберите колоду');
    document.getElementById('btn-numbers').onclick = () => state.deckCards.length ? toggleNumbers() : alert('Выберите колоду');
    document.getElementById('btn-clear').onclick = clearTable;
    document.getElementById('btn-bg').onclick = openBgModal;

    const menu = document.getElementById('context-menu');
    const closeMenu = (e) => {
        if (!menu.classList.contains('hidden')) {
            if (!e.target.closest('#context-menu') && !e.target.closest('.table-card')) hideMenu();
        }
    };
    document.addEventListener('click', closeMenu);
    document.addEventListener('touchstart', closeMenu, {passive: true});
    document.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.table-card');
        if (card) { e.preventDefault(); showMenu(e.pageX, e.pageY, card); }
    });
    document.getElementById('ctx-flip').onclick = flipCard;
    document.getElementById('ctx-delete').onclick = deleteActiveCard;
    document.getElementById('ctx-z-up').onclick = () => zAction(1);
    document.getElementById('ctx-z-down').onclick = () => zAction(-1);
    
    const scaleInput = document.getElementById('ctx-scale');
    const rotateInput = document.getElementById('ctx-rotate');
    scaleInput.oninput = () => { 
        if(state.activeCard) { 
            state.activeCard.scale = parseFloat(scaleInput.value); 
            document.getElementById('scale-val').textContent = state.activeCard.scale.toFixed(1);
            updateCardTransform(); 
        } 
    };
    scaleInput.onchange = () => { 
        if(state.activeCard) { 
            sendToServer("scale_card", { id: state.activeCard.id, scale: state.activeCard.scale }); 
            hasChanges=true; 
        } 
    };
    rotateInput.oninput = () => { 
        if(state.activeCard) { 
            state.activeCard.rotation = parseInt(rotateInput.value); 
            document.getElementById('rotate-val').textContent = state.activeCard.rotation;
            updateCardTransform(); 
        } 
    };
    rotateInput.onchange = () => { 
        if(state.activeCard) { 
            sendToServer("rotate_card", { id: state.activeCard.id, rot: state.activeCard.rotation }); 
            hasChanges=true; 
        } 
    };
    
    initPanelToggle();
}

function preloadImage(url) {
    if (!url || state.imageCache.has(url)) return;
    const img = new Image();
    img.onload = () => state.imageCache.set(url, true);
    img.onerror = () => state.imageCache.set(url, false);
    img.src = url;
}

async function loadDeck(deckId, name) {
    document.getElementById('decks-modal').classList.add('hidden');
    state.currentDeckId = deckId;
    try {
        const res = await fetch(`/api/decks/${deckId}/cards`);
        state.deckCards = await res.json();
        if (state.deckCards.length > 0) {
            preloadImage(state.deckCards[0].back_image_url);
            preloadImage(state.deckCards[0].image_url);
        }
        renderDeckPile(); activateButtons(); hasChanges = true;
    } catch(e) { alert('Ошибка загрузки: ' + e.message); }
}

function loadDeckFromServer(deckId) {
    state.currentDeckId = deckId;
    fetch(`/api/decks/${deckId}/cards`).then(r=>r.json()).then(cards => { 
        state.deckCards = cards; 
        if (cards.length > 0) {
            preloadImage(cards[0].back_image_url);
            preloadImage(cards[0].image_url);
        }
        renderDeckPile(); activateButtons(); 
    }).catch(console.error);
}

function activateButtons() {
    ['btn-shuffle','btn-flip-deck','btn-numbers','btn-clear'].forEach(id => { const b = document.getElementById(id); if(b) b.disabled = false; });
}


// renderDeckPile — ИСПРАВЛЕНО: Полная блокировка двойного клика на телефоне
function renderDeckPile() {
    const panel = document.getElementById('card-panel');
    const list = document.getElementById('card-panel-list');
    if (!state.deckCards?.length) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden'); list.innerHTML = '';
    
    state.deckCards.forEach((card, idx) => {
        const el = document.createElement('div');
        el.className = 'panel-card';
        
        // Блокируем эмуляцию клика браузером на тач-устройствах
        el.style.touchAction = 'manipulation'; 
        el.style.webkitTapHighlightColor = 'transparent';
        
        const imgUrl = state.allRevealed ? card.image_url : card.back_image_url;
        if (imgUrl) {
            el.style.backgroundImage = `url(${imgUrl})`;
            preloadImage(imgUrl);
        } else { 
            el.style.backgroundImage = 'none'; 
            el.style.backgroundColor = '#e2e8f0'; 
        }
        el.dataset.id = card.id;
        if (state.showNumbers) el.innerHTML = `<span class="card-badge">${idx + 1}</span>`;
        
        // === ЛОГИКА ДЛЯ МОБИЛЬНЫХ УСТРОЙСТВ ===
        el.addEventListener('touchstart', (e) => {
            clearTimeout(dragDelayTimer);
            isScrollingCarousel = false;
            
            const touch = e.touches[0];
            scrollStartX = touch.clientX;
            scrollStartY = touch.clientY;
            
            dragDelayTimer = setTimeout(() => {
                if (!isScrollingCarousel) {
                    state.drag.moved = false;
                    state.drag.startX = scrollStartX;
                    state.drag.startY = scrollStartY;
                    startPanelDrag(e, card);
                }
            }, DRAG_DELAY);
        }, { passive: true });
        
        el.addEventListener('touchmove', (e) => {
            if (dragDelayTimer && !isScrollingCarousel) {
                const touch = e.touches[0];
                const dx = Math.abs(touch.clientX - scrollStartX);
                const dy = Math.abs(touch.clientY - scrollStartY);
                
                if (dx > SCROLL_THRESHOLD && dx > dy) {
                    isScrollingCarousel = true;
                    clearTimeout(dragDelayTimer);
                    dragDelayTimer = null;
                }
            }
        }, { passive: true });
        
        // ЕДИНСТВЕННОЕ место добавления карты на мобильных
        el.addEventListener('touchend', (e) => {
            // Явно предотвращаем эмуляцию последующего click
            e.preventDefault(); 
            
            if (dragDelayTimer) {
                clearTimeout(dragDelayTimer);
                dragDelayTimer = null;
                if (!isScrollingCarousel && !state.drag.moved) {
                    addCardToTable(card);
                }
            }
        }, { passive: false }); // ⚠️ Важно: passive: false, чтобы preventDefault работал
        
        // === ЛОГИКА ТОЛЬКО ДЛЯ ДЕСКТОПА ===
        if (!('ontouchstart' in window)) {
            el.onmousedown = (e) => { 
                state.drag.moved = false; 
                state.drag.startX = e.clientX; 
                state.drag.startY = e.clientY; 
                startPanelDrag(e, card); 
            };
            el.onclick = () => { 
                if (!state.drag.moved) addCardToTable(card); 
            };
        }
        
        list.appendChild(el);
    });
    
    //  УСКОРЕННЫЙ скролл карусели колесом мыши (x2.5)
    list.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            list.scrollLeft += e.deltaY * 2.5;
        }
    }, { passive: false });
}

function addCardToTable(cardData) {
    const idx = state.deckCards.findIndex(c => c.id === cardData.id);
    if (idx !== -1) state.deckCards.splice(idx, 1);
    const canvas = document.getElementById('canvas');
    const cRect = canvas.getBoundingClientRect();
    
    const scale = state.tableScale || 1;
    const x = ((window.innerWidth / 2) - cRect.left) / scale - 60 + (Math.random() * 40 - 20);
    const y = ((window.innerHeight / 2) - cRect.top) / scale - 90 + (Math.random() * 40 - 20);
    
    // Учитываем state.allRevealed — если колода открыта, карта тоже открыта
    const cardObj = { 
        id: cardData.id, 
        imgUrl: cardData.image_url, 
        backUrl: cardData.back_image_url, 
        x, y, 
        rotation: 0, 
        scale: 1, 
        flipped: state.allRevealed, // Было false, стало state.allRevealed
        z: getHighestZ() + 1 
    };
    sendToServer("add_card", { card: cardObj });
    renderCardOnTable(cardObj);
    renderDeckPile(); hasChanges = true;
}

function startPanelDrag(e, cardData) {
    if (isScrollingCarousel) return;
    
    e.preventDefault();
    const startX = e.touches ? e.touches[0].clientX : e.clientX;
    const startY = e.touches ? e.touches[0].clientY : e.clientY;
    const ghost = document.createElement('div');
    ghost.className = 'table-card';
    const imgUrl = state.allRevealed ? cardData.image_url : cardData.back_image_url;
    if (imgUrl) ghost.style.backgroundImage = `url(${imgUrl})`;
    else { ghost.style.backgroundImage = 'none'; ghost.style.backgroundColor = 'transparent'; }
    ghost.style.cssText = `width:90px;height:130px;position:fixed;z-index:9999;pointer-events:none;opacity:0.8;left:${startX-45}px;top:${startY-65}px`;
    document.body.appendChild(ghost);
    const move = (ev) => {
        const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
        const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
        const dist = Math.hypot(cx - state.drag.startX, cy - state.drag.startY);
        if (dist > state.drag.threshold) state.drag.moved = true;
        ghost.style.left = (cx-45)+'px'; ghost.style.top = (cy-65)+'px';
    };
    const drop = (ev) => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', drop);
    document.removeEventListener('touchmove', move); document.removeEventListener('touchend', drop);
    ghost.remove();
    if (state.drag.moved) {
        const canvas = document.getElementById('canvas');
        const cRect = canvas.getBoundingClientRect();
        const cx = ev.changedTouches ? ev.changedTouches[0].clientX : ev.clientX;
        const cy = ev.changedTouches ? ev.changedTouches[0].clientY : ev.clientY;
        const table = document.getElementById('table-area').getBoundingClientRect();
        if (cx > table.left && cx < table.right && cy > table.top && cy < table.bottom) {
            const idx = state.deckCards.findIndex(c => c.id === cardData.id);
            if (idx !== -1) state.deckCards.splice(idx, 1);
            
            const scale = state.tableScale || 1;
            const x = (cx - cRect.left) / scale - 45;
            const y = (cy - cRect.top) / scale - 65;
            
            // Учитываем state.allRevealed при перетаскивании
            const cardObj = { 
                id: cardData.id, 
                imgUrl: cardData.image_url, 
                backUrl: cardData.back_image_url, 
                x, y, 
                rotation: 0, 
                scale: 1, 
                flipped: state.allRevealed, //  Было false, стало state.allRevealed
                z: getHighestZ() + 1 
            };
            sendToServer("add_card", { card: cardObj });
            renderCardOnTable(cardObj);
            renderDeckPile(); hasChanges=true;
        }
    }
    setTimeout(() => state.drag.moved = false, 50);
};
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', drop);
    document.addEventListener('touchmove', move, {passive:false}); document.addEventListener('touchend', drop);
}

function setupTablePan() {
    const canvas = document.getElementById('canvas');
    const table = document.getElementById('table-area');
        // ГАРАНТИРОВАННЫЙ ЗАПРЕТ КОНТЕКСТНОГО МЕНЮ БРАУЗЕРА НА СТОЛЕ
    const preventBrowserMenu = (e) => {
        e.preventDefault();
        return false;
    };

    // Блокируем на столе и холсте
    table.addEventListener('contextmenu', preventBrowserMenu);
    canvas.addEventListener('contextmenu', preventBrowserMenu);
    
    // Глобальная блокировка для всего документа, кроме полей ввода
    document.addEventListener('contextmenu', (e) => {
        if (!e.target.closest('input') && !e.target.closest('textarea')) {
            e.preventDefault();
        }
    });
    if (!canvas || !table) return;
    
    const MIN_SCALE = 0.3;
    const MAX_SCALE = 3;
    // 0.3 = 30% за прокрутку (~8-9 прокруток от края до края). 
    // Если мало, поставь 0.5 (будет 5-6 прокруток, но очень резко).
    const ZOOM_SPEED = 0.1; 
    
    function applyCanvasTransform() {
        canvas.style.transform = `translate(${state.tableTranslateX}px, ${state.tableTranslateY}px) scale(${state.tableScale})`;
    }
    
    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    
    const startPan = (e) => {
        if (e.target.closest('.table-card') || e.target.closest('#context-menu') || e.target.closest('.ctx-control')) return;
        
        if (e.touches && e.touches.length >= 2) {
            e.preventDefault();
            isPanning = true;
            canvas.classList.add('panning');
            
            const t1 = e.touches[0], t2 = e.touches[1];
            const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            
            dragData = {
                type: 'table-zoom',
                startDist: dist,
                startScale: state.tableScale,
                viewportCenterX: window.innerWidth / 2,
                viewportCenterY: window.innerHeight / 2,
                startTranslateX: state.tableTranslateX,
                startTranslateY: state.tableTranslateY
            };
            return;
        }
        
        isPanning = true; 
        canvas.classList.add('panning');
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        panStartX = cx - state.tableTranslateX; 
        panStartY = cy - state.tableTranslateY; 
        e.preventDefault();
    };
    
    const pan = (e) => {
        if (!isPanning) return;
        e.preventDefault();
        
        if (dragData?.type === 'table-zoom' && e.touches && e.touches.length >= 2) {
            const t1 = e.touches[0], t2 = e.touches[1];
            const curDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            
            const scaleRatio = curDist / dragData.startDist;
            let newScale = dragData.startScale * scaleRatio;
            newScale = Math.min(Math.max(newScale, MIN_SCALE), MAX_SCALE);
            
            const scaleChange = newScale / dragData.startScale;
            const cx = dragData.viewportCenterX;
            const cy = dragData.viewportCenterY;
            
            state.tableTranslateX = cx - (cx - dragData.startTranslateX) * scaleChange;
            state.tableTranslateY = cy - (cy - dragData.startTranslateY) * scaleChange;
            state.tableScale = newScale;
            applyCanvasTransform();
            return;
        }
        
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        state.tableTranslateX = cx - panStartX; 
        state.tableTranslateY = cy - panStartY;
        applyCanvasTransform();
    };
    
    const endPan = () => { 
        isPanning = false; 
        canvas.classList.remove('panning');
        if (dragData?.type === 'table-zoom') {
            dragData = null;
        }
    };
    
    // Обработчик зума
    const wheelHandler = (e) => {
        if (e.target.closest('#context-menu') || e.target.closest('.ctx-control') || e.target.closest('.card-panel')) return;
        
        e.preventDefault();
        
        const mouseX = e.clientX;
        const mouseY = e.clientY;
        
        // Фиксированный шаг на каждый "тик" колеса, независимо от силы прокрутки
        const direction = Math.sign(e.deltaY); // -1 (к себе) или 1 (от себя)
        const delta = 1 + (direction * ZOOM_SPEED);
        let newScale = state.tableScale * delta;
        
        newScale = Math.min(Math.max(newScale, MIN_SCALE), MAX_SCALE);
        
        // Формула зума строго от позиции курсора
        const scaleRatio = newScale / state.tableScale;
        const newTranslateX = mouseX - (mouseX - state.tableTranslateX) * scaleRatio;
        const newTranslateY = mouseY - (mouseY - state.tableTranslateY) * scaleRatio;
        
        state.tableScale = newScale;
        state.tableTranslateX = newTranslateX;
        state.tableTranslateY = newTranslateY;
        applyCanvasTransform();
    };

    // Удаляем старые слушатели, чтобы не дублировались при обновлении
    table.removeEventListener('wheel', wheelHandler, { passive: false, capture: true });
    canvas.removeEventListener('wheel', wheelHandler, { passive: false, capture: true });

    // capture: true — КЛЮЧЕВОЙ МОМЕНТ! Заставляет браузер обрабатывать зум ПЕРВЫМ, 
    // до того как его перехватят карты или скролл страницы.
    table.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
    canvas.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
    
    table.addEventListener('mousedown', startPan); 
    document.addEventListener('mousemove', pan); 
    document.addEventListener('mouseup', endPan);
    table.addEventListener('touchstart', startPan, {passive: false}); 
    document.addEventListener('touchmove', pan, {passive: false}); 
    document.addEventListener('touchend', endPan);
    table.addEventListener('touchcancel', endPan);
}

//  setupTableDrag
function setupTableDrag() {
    const canvas = document.getElementById('canvas');
    if (!canvas) return;
    
    let dragTarget = null;
    let isDragging = false;
    let lastTap = 0;

    const startDragLogic = (clientX, clientY, card) => {
        if (dragTarget) return;
        dragTarget = card;
        isDragging = false;
        card.classList.add('dragging');
        
        const cRect = canvas.getBoundingClientRect();
        dragData = {
            type: 'drag',
            startX: clientX,
            startY: clientY,
            startLeft: parseFloat(card.style.left) || 0,
            startTop: parseFloat(card.style.top) || 0,
            canvasLeft: cRect.left,
            canvasTop: cRect.top,
            tableScale: state.tableScale
        };
    };

    const moveDragLogic = (clientX, clientY) => {
        if (!dragTarget || !dragData || dragData.type !== 'drag') return;
        
        const dist = Math.hypot(clientX - dragData.startX, clientY - dragData.startY);
        if (dist <= state.drag.threshold && !isDragging) return;
        
        isDragging = true;
        
        const cRect = canvas.getBoundingClientRect();
        const deltaX = clientX - dragData.startX;
        const deltaY = clientY - dragData.startY;
        const canvasShiftX = cRect.left - dragData.canvasLeft;
        const canvasShiftY = cRect.top - dragData.canvasTop;
        
        const scale = dragData.tableScale || state.tableScale || 1;
        dragTarget.style.left = (dragData.startLeft + (deltaX - canvasShiftX) / scale) + 'px';
        dragTarget.style.top = (dragData.startTop + (deltaY - canvasShiftY) / scale) + 'px';
    };

    const endDragLogic = () => {
        if (!dragTarget) return;
        dragTarget.classList.remove('dragging');
        
        if (dragData?.type === 'drag' && isDragging) {
            const c = state.tableCards.find(x => x.el === dragTarget);
            if (c) {
                sendToServer("move_card", { 
                    id: c.id, 
                    x: parseFloat(dragTarget.style.left) || 0, 
                    y: parseFloat(dragTarget.style.top) || 0 
                });
                hasChanges = true;
            }
        } else if (dragData?.type === 'drag' && !isDragging) {
            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTap;
            if (tapLength < 300 && tapLength > 0) {
                const c = state.tableCards.find(x => x.el === dragTarget);
                if (c) {
                    state.activeCard = c;
                    flipCard();
                    state.activeCard = null;
                }
            }
            lastTap = currentTime;
        }
        
        dragTarget = null;
        dragData = null;
        isDragging = false;
    };

    canvas.addEventListener('touchstart', (e) => {
        const card = e.target.closest('.table-card');
        if (!card) return;
        
        if (e.touches.length >= 2) {
            e.preventDefault();
            dragTarget = card;
            dragTarget.classList.add('dragging');
            
            const t1 = e.touches[0], t2 = e.touches[1];
            const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            const angle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX) * 180 / Math.PI;
            
            const c = state.tableCards.find(x => x.el === card);
            dragData = {
                type: 'pinch',
                startDist: dist,
                startAngle: angle,
                startScale: c ? c.scale : 1,
                startRot: c ? c.rotation : 0,
                cardObj: c
            };
            return;
        }
        
        // ОДИН ПАЛЕЦ: сразу назначаем максимальный z-index (для мобилок)
        const c = state.tableCards.find(x => x.el === card);
        if (c) {
            c.zIndex = getHighestZ() + 1;
            c.el.style.zIndex = c.zIndex;
            sendToServer("z_card", { id: c.id, z: c.zIndex });
            hasChanges = true;
        }
        
        const touch = e.touches[0];
        startDragLogic(touch.clientX, touch.clientY, card);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        if (!dragTarget || !dragData) return;
        e.preventDefault();
        
        if (dragData.type === 'pinch' && e.touches.length >= 2) {
            const t1 = e.touches[0], t2 = e.touches[1];
            const curDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            const curAngle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX) * 180 / Math.PI;
            
            const scaleDiff = curDist / dragData.startDist;
            const angleDiff = curAngle - dragData.startAngle;
            
            let newScale = dragData.startScale * scaleDiff;
            let newRot = dragData.startRot + angleDiff;
            
            newScale = Math.min(Math.max(newScale, 0.5), 3);
            
            if (dragData.cardObj) {
                dragData.cardObj.scale = newScale;
                dragData.cardObj.rotation = newRot;
                dragTarget.style.transform = `rotate(${newRot}deg) scale(${newScale})`;
            }
        } else if (dragData.type === 'drag') {
            const touch = e.touches[0];
            moveDragLogic(touch.clientX, touch.clientY);
        }
    }, { passive: false });

    canvas.addEventListener('touchend', endDragLogic);
    canvas.addEventListener('touchcancel', endDragLogic);

    canvas.addEventListener('mousedown', (e) => {
        const card = e.target.closest('.table-card');
        if (!card) return;
        
        if (e.button === 2) {
            e.preventDefault();
            showMenu(e.pageX, e.pageY, card);
            return;
        }
        startDragLogic(e.clientX, e.clientY, card);
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!dragTarget) return;
        moveDragLogic(e.clientX, e.clientY);
    }, { passive: false });

    canvas.addEventListener('mouseup', endDragLogic);
    canvas.addEventListener('mouseleave', endDragLogic);
    
    canvas.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.table-card')) e.preventDefault();
    });
}

function getHighestZ() { 
    if (state.tableCards.length === 0) return 0; 
    let max = 0; 
    for (const c of state.tableCards) { 
        const z = c.zIndex || 0; 
        if (z > max) max = z; 
    } 
    return max; 
}

function getLowestZ() { 
    if (state.tableCards.length === 0) return 1; 
    let min = Infinity; 
    for (const c of state.tableCards) { 
        const z = c.zIndex || 1; 
        if (z < min) min = z; 
    } 
    return min; 
}

function moveCardLocal(id, x, y) { 
    const c = state.tableCards.find(t => t.id === id); 
    if(c) {
        c.el.style.left = x + 'px'; 
        c.el.style.top = y + 'px';
    } 
}

function flipCardLocal(id, f) { 
    const c = state.tableCards.find(t => t.id === id); 
    if(c){ 
        c.flipped = f; 
        const bg = f ? c.imgUrl : c.backUrl;
        if (bg) {
            c.inner.dataset.bg = bg;
            if (state.imageCache.get(bg)) {
                c.inner.style.backgroundImage = `url(${bg})`;
            } else {
                c.inner.style.backgroundImage = 'none';
                loadCardImage(c.inner, bg);
            }
        } else { 
            c.inner.style.backgroundImage = 'none'; 
            c.inner.style.backgroundColor = '#e2e8f0'; 
        }
    } 
}

function renderCardOnTable(c) {
    if (!c?.id || state.tableCards.find(x => x.id === c.id)) return;
    
    const el = document.createElement('div');
    el.className = 'table-card';
    el.dataset.cardId = c.id;
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.style.zIndex = c.z || 1;
    el.style.transform = `rotate(${c.rotation||0}deg) scale(${c.scale||1})`;
    
    const inner = document.createElement('div');
    inner.className = 'table-card-inner';
    
    const bg = c.flipped ? c.imgUrl : c.backUrl;
    if (bg) {
        inner.dataset.bg = bg;
        inner.style.backgroundColor = '#e2e8f0';
        
        if (state.imageCache.get(bg)) {
            inner.style.backgroundImage = `url(${bg})`;
        } else {
            loadCardImage(inner, bg);
        }
    } else {
        inner.style.backgroundColor = '#e2e8f0';
    }
    
    el.appendChild(inner);
    document.getElementById('canvas').appendChild(el);
    
    state.tableCards.push({ 
        el, inner, id: c.id, imgUrl: c.imgUrl, backUrl: c.backUrl,
        x: c.x, y: c.y, rotation: c.rotation||0, scale: c.scale||1,
        flipped: c.flipped, zIndex: c.z || 1
    });
}

function rotateCardLocal(id, r) { 
    const c = state.tableCards.find(t => t.id === id); 
    if(c){ 
        c.rotation = r; 
        updateCardTransform(); 
    }
}

function scaleCardLocal(id, s) { 
    const c = state.tableCards.find(t => t.id === id); 
    if(c){ 
        c.scale = s; 
        updateCardTransform(); 
    }
}

function zCardLocal(id, z) { 
    const c = state.tableCards.find(t => t.id === id); 
    if(c){ 
        c.zIndex = z; 
        c.el.style.zIndex = z; 
    } 
}

function deleteCardLocal(id) { 
    const idx = state.tableCards.findIndex(c => c.id === id); 
    if (idx !== -1) { 
        state.tableCards[idx].el.remove(); 
        state.tableCards.splice(idx, 1); 
    } 
}

function clearTableLocal() { 
    document.getElementById('canvas').innerHTML=''; 
    state.tableCards=[]; 
}

function shuffleDeckLocal(order) { 
    if(!order) return; 
    state.deckCards.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id)); 
    renderDeckPile(); 
}

function toggleRevealedLocal(rev) {
    state.allRevealed = rev;
    
    // Сортируем карты по Z-index — сначала обновляем те, что сверху (видимые)
    const sortedCards = [...state.tableCards].sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));
    
    sortedCards.forEach((c, index) => { 
        c.flipped = rev; 
        const bg = rev ? c.imgUrl : c.backUrl; 
        
        if (bg) {
            c.inner.dataset.bg = bg;
            
            // Первые 12 карт (верхние/видимые) грузим сразу
            if (index < 12 && state.imageCache.get(bg)) {
                c.inner.style.backgroundImage = `url(${bg})`;
            } else if (index < 12) {
                // Видимые карты — ставим в начало очереди загрузки
                c.inner.style.backgroundImage = 'none';
                loadCardImage(c.inner, bg);
            } else {
                // Невидимые карты — просто запоминаем URL, фон подгрузится позже
                c.inner.style.backgroundColor = '#e2e8f0';
                c.inner.dataset.bg = bg;
            }
        } else { 
            c.inner.style.backgroundImage = 'none'; 
            c.inner.style.backgroundColor = '#e2e8f0'; 
        }
    });
    
    document.querySelectorAll('.panel-card').forEach(el => { 
        const card = state.deckCards.find(c => c.id === el.dataset.id); 
        if (card) { 
            const bg = rev ? card.image_url : card.back_image_url; 
            if (bg) el.style.backgroundImage = `url(${bg})`; 
            else { el.style.backgroundImage = 'none'; el.style.backgroundColor = '#e2e8f0'; } 
        } 
    });
}

function toggleNumbersLocal(show) { 
    state.showNumbers = show; 
    renderDeckPile(); 
}

function changeBgLocal(bgValue) {
    state.currentBg = bgValue; 
    const table = document.getElementById('table-area');
    ['bg-blue','bg-green','bg-yellow','bg-stone','bg-wood'].forEach(cls => table.classList.remove(cls));
    if (bgValue && bgValue.startsWith('/uploads/')) { 
        table.style.backgroundImage = `url(${bgValue})`; 
        table.style.backgroundSize = 'cover'; 
        table.style.backgroundPosition = 'center'; 
    }
    else if (bgValue) { 
        table.style.backgroundImage = ''; 
        table.classList.add(bgValue); 
    }
    else { 
        table.style.backgroundImage = ''; 
        table.style.backgroundColor = '#d8ede3';
    }
}

function updateCardTransform() { 
    if(state.activeCard?.el) {
        state.activeCard.el.style.transform = `rotate(${state.activeCard.rotation}deg) scale(${state.activeCard.scale})`;
    }
}

function showMenu(x, y, el) { 
    state.activeCard = state.tableCards.find(t => t.el === el); 
    if (!state.activeCard) return; 
    
    document.getElementById('ctx-scale').value = state.activeCard.scale || 1;
    document.getElementById('ctx-rotate').value = state.activeCard.rotation || 0;
    document.getElementById('scale-val').textContent = (state.activeCard.scale || 1).toFixed(1);
    document.getElementById('rotate-val').textContent = state.activeCard.rotation || 0;
    
    const m = document.getElementById('context-menu'); 
    if (!m) return;
    
    if (window.innerWidth <= 768) {
        m.style.left = '50%'; m.style.right = 'auto'; m.style.top = 'auto'; m.style.bottom = '0';
    } else {
        m.style.left = Math.min(x, window.innerWidth - 220) + 'px'; m.style.right = 'auto';
        m.style.top = Math.min(y, window.innerHeight - 300) + 'px'; m.style.bottom = 'auto';
        m.style.transform = 'scale(0.95)';
    }
    m.classList.remove('hidden');
    requestAnimationFrame(() => { m.classList.add('visible'); });
}

function flipCard() { 
    if (!state.activeCard) return; 
    state.activeCard.flipped = !state.activeCard.flipped; 
    sendToServer("flip_card", { id: state.activeCard.id, flipped: state.activeCard.flipped }); 
    flipCardLocal(state.activeCard.id, state.activeCard.flipped); 
    hideMenu(); hasChanges = true; 
}

function deleteActiveCard() { 
    if (!state.activeCard) return; 
    sendToServer("delete_card", { id: state.activeCard.id }); 
    deleteCardLocal(state.activeCard.id); 
    hideMenu(); hasChanges = true; 
}

function zAction(dir) { 
    if (!state.activeCard || !state.activeCard.el) return; 
    if (dir === 1) state.activeCard.zIndex = getHighestZ() + 1; else state.activeCard.zIndex = getLowestZ() - 1;
    state.activeCard.el.style.zIndex = state.activeCard.zIndex;
    sendToServer("z_card", { id: state.activeCard.id, z: state.activeCard.zIndex });
    hideMenu(); hasChanges = true; 
}

function hideMenu() { 
    const m = document.getElementById('context-menu'); if (!m) return;
    m.classList.remove('visible');
    setTimeout(() => { m.classList.add('hidden'); }, 200);
    state.activeCard = null;
}

function shuffleDeck() { 
    for(let i=state.deckCards.length-1;i>0;i--){
        const j=Math.floor(Math.random()*(i+1));
        [state.deckCards[i],state.deckCards[j]]=[state.deckCards[j],state.deckCards[i]];
    } 
    sendToServer("shuffle_deck", {order: state.deckCards.map(c=>c.id)}); 
    renderDeckPile(); 
    hasChanges=true; 
}

function toggleDeckVisibility() { 
    state.allRevealed = !state.allRevealed; 
    sendToServer("toggle_revealed", {revealed: state.allRevealed}); 
    toggleRevealedLocal(state.allRevealed); 
    hasChanges = true; 
}

function toggleNumbers() { 
    state.showNumbers = !state.showNumbers; 
    sendToServer("toggle_numbers", {show: state.showNumbers}); 
    toggleNumbersLocal(state.showNumbers); 
    hasChanges = true; 
}

function changeBackground() { 
    const bgs=['','bg-blue','bg-green','bg-yellow','bg-stone','bg-wood']; 
    state.currentBg = bgs[(bgs.indexOf(state.currentBg)+1)%bgs.length]; 
    sendToServer("change_background",{bg:state.currentBg}); 
    changeBgLocal(state.currentBg); 
    hasChanges=true; 
}

function clearTable() { 
    sendToServer("clear_table"); 
    clearTableLocal(); 
    hasChanges=true; 
}

const BG_OPTIONS = [ 
    { id: '', name: 'По умолчанию', css: '#d8ede3' }, 
    { id: 'bg-blue', name: 'Голубой', css: 'linear-gradient(135deg, #a8c0e0, #c5d5ea)' }, 
    { id: 'bg-green', name: 'Зелёный', css: 'linear-gradient(135deg, #b8d9c9, #d4e8d9)' }, 
    { id: 'bg-yellow', name: 'Жёлтый', css: 'linear-gradient(135deg, #f0e6b8, #f5ecd4)' }, 
    { id: 'bg-stone', name: 'Камень', css: 'linear-gradient(135deg, #b8b5b0, #d1cec8)' }, 
    { id: 'bg-wood', name: 'Дерево', css: '#c9a97e' } 
];

async function openBgModal() {
    const modal = document.getElementById('bg-modal');
    const list = document.getElementById('bg-list');
    if (!modal || !list) return;
    
    modal.classList.remove('hidden');
    list.innerHTML = '<p style="text-align:center; padding:20px;">⏳ Загрузка...</p>';
    list.innerHTML = '';
    BG_OPTIONS.forEach(bg => list.appendChild(createBgItem(bg)));

    try {
        const res = await fetch('/api/admin/backgrounds');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const backgrounds = await res.json();
        backgrounds.forEach(bg => {
            const item = document.createElement('div');
            item.className = 'bg-item' + (state.currentBg === bg.image_url ? ' active' : '');
            item.style.backgroundImage = `url(${bg.image_url})`;
            item.style.backgroundSize = 'cover';
            item.style.backgroundPosition = 'center';
            item.innerHTML = `<span>${bg.name}</span>`;
            item.onclick = () => { selectBackground(bg.image_url); modal.classList.add('hidden'); };
            list.appendChild(item);
        });
    } catch (e) {
        console.warn("️ Не удалось загрузить кастомные фоны:", e.message);
    }
}

function createBgItem(bg) { 
    const item = document.createElement('div'); 
    item.className = 'bg-item' + (state.currentBg === bg.id ? ' active' : ''); 
    item.style.background = bg.css; 
    item.innerHTML = `<span>${bg.name}</span>`; 
    item.onclick = () => { selectBackground(bg.id); document.getElementById('bg-modal').classList.add('hidden'); }; 
    return item; 
}

function selectBackground(bgValue) { 
    state.currentBg = bgValue; 
    changeBgLocal(bgValue); 
    sendToServer("change_background", { bg: bgValue }); 
    hasChanges = true; 
}

function initPanelToggle() {
    const toggle = document.getElementById('panel-toggle');
    const panel = document.getElementById('card-panel');
    if (!toggle || !panel) return;

    toggle.onclick = (e) => {
        e.stopPropagation();
        panel.classList.toggle('expanded');
    };
    
    const list = document.getElementById('card-panel-list');
    if(list) {
        list.addEventListener('touchstart', () => {
             if(!panel.classList.contains('expanded')) {
                 panel.classList.add('expanded');
             }
        }, {passive: true});
    }
}

function toggleFullscreen() {
    const doc = document.documentElement;
    const isFullscreen = document.fullscreenElement || 
                         document.webkitFullscreenElement || 
                         document.mozFullScreenElement || 
                         document.msFullscreenElement;
    
    if (!isFullscreen) {
        if (doc.requestFullscreen) doc.requestFullscreen();
        else if (doc.webkitRequestFullscreen) doc.webkitRequestFullscreen();
        else if (doc.mozRequestFullScreen) doc.mozRequestFullScreen();
        else if (doc.msRequestFullscreen) doc.msRequestFullscreen();
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
        else if (document.msExitFullscreen) document.msExitFullscreen();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const btnFullscreen = document.getElementById('btn-fullscreen');
    if (btnFullscreen) btnFullscreen.onclick = toggleFullscreen;
});