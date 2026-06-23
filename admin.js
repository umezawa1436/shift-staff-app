const SUPABASE_URL = 'https://plbbofopqgkwwogfonrs.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYmJvZm9wcWdrd3dvZ2ZvbnJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjg4MDcsImV4cCI6MjA5MzY0NDgwN30.n1HPR_Ipcg79fYrWkr3D76zQGuTFO0gji5T7kqlt5QE'; 
// STATE
let adminUser = null;
// ★ 所定労働時間の算出定数（DB app_settings で一元管理。未設定時は従来値にフォールバック）
//   短時間係数 short_ratio と、monthly_hours 未設定月のデフォルト基準 default_planned_hours。
//   admin.js / admin-generate.js / index.html(スタッフ画面) が各自このテーブルを読むことで二重管理を解消。
let APP_SHORT_RATIO = 0.75;
let APP_DEFAULT_PLAN_HOURS = 171.4;
async function loadAppSettings() {
  try {
    const rows = await sb('app_settings?select=key,value');
    (rows || []).forEach(r => {
      if (r.key === 'short_ratio' && r.value != null) APP_SHORT_RATIO = parseFloat(r.value);
      if (r.key === 'default_planned_hours' && r.value != null) APP_DEFAULT_PLAN_HOURS = parseFloat(r.value);
    });
  } catch(e) {
    console.warn('app_settings 読み込みスキップ（デフォルト値を使用）:', e);
  }
}
let currentDept = 0;
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1;
let reqYear = new Date().getFullYear(), reqMonth = new Date().getMonth() + 1;
let shiftYear = new Date().getFullYear(), shiftMonth = new Date().getMonth() + 1;
let dashYear = new Date().getFullYear(), dashMonth = new Date().getMonth() + 1;
let genYear = new Date().getFullYear(), genMonth = new Date().getMonth() + 1;
let allStaff = [], shiftData = {}, lockedCells = {}, wedTypes = {}, generatedShifts = {};
// ★ シフト表セル内のロックアイコン🔒の表示/非表示（コーナーのボタンで切替。ロック状態自体は保持）
let hideLockIcons = false;
// 遅番系(遅番+遅L)・長日の月間回数カウント列の表示フラグ（医療事務のみ・localStorage永続）
let showLateLongCount = (typeof localStorage !== 'undefined' && localStorage.getItem('shift_late_long_count') === '1');
// ★ AI 生成プレビュー用：生成前の状態スナップショット（破棄時の復元用）
let preAIGenerationSnapshot = null;
// ★ 確定ロック：現在表示中の月が確定済みかどうか
let isCurrentMonthConfirmed = false;
// シフト表の状態管理
let shiftGridContext = null; // 'dept|year|month' - 現在ロード済みのコンテキスト
let savedShiftSnapshot = null; // 最後の保存時点（DBロード時 or 保存成功時に更新）
let shiftMonthCache = {}; // {ctx: {shiftData, lockedCells, savedShiftSnapshot, undoStack, redoStack}} 月・部署切替時の状態保持用


// ===== 共通：自動生成と描画の両方で使うシンボル（admin-generate.js から移動） =====

// --- シフトパターン候補（loadShiftTypesAndBuildMaps が再構築する） ---
const SHIFT_PATTERN_OPTIONS = [
  { id: '日勤',   label: '日勤',   time: '8:30-18:00' },
  { id: '日勤+',  label: '日勤+',  time: '8:30-18:30' },
  { id: '午前',   label: '午前',   time: '8:30-13:30' },
  { id: '午後',   label: '午後',   time: '13:00-18:30' },
  { id: '遅番',   label: '遅番',   time: '13:00-21:30' },
  { id: '遅L',    label: '遅L',    time: '12:00-21:30' },
  { id: 'リハ遅', label: 'リハ遅', time: '12:00-21:00' },
  { id: '夜勤',   label: '夜勤',   time: '17:30-21:30' },
  { id: '長日',   label: '長日',   time: '8:30-21:30' },
  { id: '中抜け', label: '中抜け', time: '8:30-21:30' },
  { id: '時短',   label: '時短',   time: '8:30-14:30' },
];

// --- 日本の祝日（描画・計算・生成すべてで使用） ---
function getJapaneseHolidays(year, month) {
  const holidays = {
    '2026-1': [1],
    '2026-2': [11,23],
    '2026-3': [20],
    '2026-4': [29],
    '2026-5': [3,4,5,6],
    '2026-7': [20],
    '2026-8': [11],
    '2026-9': [21,22],
    '2026-10': [12],
    '2026-11': [3,23],
    '2026-12': [],
  };
  return new Set(holidays[`${year}-${month}`] || []);
}

// 現在の状態をキャッシュに保存（コンテキスト切替前に呼ぶ）
function saveCurrentShiftStateToCache() {
  if (!shiftGridContext) return;
  shiftMonthCache[shiftGridContext] = {
    shiftData: JSON.parse(JSON.stringify(shiftData)),
    lockedCells: JSON.parse(JSON.stringify(lockedCells)),
    savedShiftSnapshot: savedShiftSnapshot ? JSON.parse(JSON.stringify(savedShiftSnapshot)) : null,
    undoStack: undoStack.slice(),
    redoStack: redoStack.slice(),
    // ★ 確定ロック状態も保存（部署/月切替で復元するため）
    isCurrentMonthConfirmed,
    // 表示用の参照データ（スタッフ希望・水曜種別・休診情報）もキャッシュ
    reqMap: window._shiftReqMap ? JSON.parse(JSON.stringify(window._shiftReqMap)) : {},
    wedTypes: window._shiftWedTypes ? JSON.parse(JSON.stringify(window._shiftWedTypes)) : {},
    closedHolidays: window._shiftClosedHolidays ? Array.from(window._shiftClosedHolidays) : [],
    openThursdays: window._shiftOpenThursdays ? Array.from(window._shiftOpenThursdays) : [],
    customClosed: window._shiftCustomClosed ? JSON.parse(JSON.stringify(window._shiftCustomClosed)) : {}
  };
}

// キャッシュから復元（成功時 true）
function tryRestoreShiftStateFromCache(ctx) {
  if (!shiftMonthCache[ctx]) return false;
  const c = shiftMonthCache[ctx];
  shiftData = JSON.parse(JSON.stringify(c.shiftData));
  lockedCells = JSON.parse(JSON.stringify(c.lockedCells));
  savedShiftSnapshot = c.savedShiftSnapshot ? JSON.parse(JSON.stringify(c.savedShiftSnapshot)) : null;
  undoStack = c.undoStack.slice();
  redoStack = c.redoStack.slice();
  // ★ 確定ロック状態を復元 + UI 更新
  isCurrentMonthConfirmed = !!c.isCurrentMonthConfirmed;
  updateConfirmLockUI();
  // 表示用の参照データも復元
  window._shiftReqMap = c.reqMap ? JSON.parse(JSON.stringify(c.reqMap)) : {};
  window._shiftWedTypes = c.wedTypes ? JSON.parse(JSON.stringify(c.wedTypes)) : {};
  window._shiftClosedHolidays = new Set(c.closedHolidays || []);
  window._shiftOpenThursdays = new Set(c.openThursdays || []);
  window._shiftCustomClosed = c.customClosed ? JSON.parse(JSON.stringify(c.customClosed)) : {};
  shiftGridContext = ctx;
  return true;
}
let editingCell = null;

const DEPT_NAMES = {0:'医療事務',1:'看護',2:'リハビリ',3:'放射線'};
const DEPT_IDS = [0,1,2,3];
const DOW = ['日','月','火','水','木','金','土'];
const MASTER_PW = 'master1234', LEADER_PW = 'leader1234';

const SHIFT_OPTIONS = ['日勤','日勤+','午前','午後','遅番','遅L','リハ遅','夜勤','長日','中抜け','時短','CC','CHO','CCのみ','休み','有休','半有休','個夏休','希望休'];

const SHIFT_COLORS = {
  '日勤':'sc-日勤','日勤+':'sc-日勤+','午前':'sc-午前','午後':'sc-午後',
  '遅番':'sc-遅番','遅L':'sc-遅L','リハ遅':'sc-リハ遅','夜勤':'sc-夜勤',
  '長日':'sc-長日','中抜け':'sc-中抜け','時短':'sc-時短',
  'CC':'sc-CC','CHO':'sc-CHO','CCのみ':'sc-CCのみ',
  '休み':'sc-休み','有休':'sc-有休','半有休':'sc-半有休','個夏休':'sc-個夏休','希望休':'sc-希望休'
};

// シフトの実働時間
// 有休の加算時間：土日祝なら9H、平日なら8.5H
function getYukyuHours(dow, isHoliday) {
  return (dow === 0 || dow === 6 || isHoliday) ? 9 : 8.5;
}

// 有給と同じ時間計算をする休みシフト（土日祝9H、平日8.5H）
const PAID_LEAVE_SHIFTS = ['有休', '個夏休'];

// 休み系シフトの加算時間取得
function getRestShiftHours(shift, dow, isHoliday) {
  if (PAID_LEAVE_SHIFTS.includes(shift)) return getYukyuHours(dow, isHoliday);
  if (shift === '半有休') return 5;
  return 0;
}

const SHIFT_HOURS = {
  '日勤':8.5,'日勤+':9,'午前':5,'午後':5,'遅番':7.5,'遅L':8.5,
  'リハ遅':8,'夜勤':4,'長日':11,'中抜け':8,'時短':6,'CC':8,'CHO':7,
  'CCのみ':3,'休み':0,'有休':0,'半有休':0,'個夏休':0,'希望休':0
};

// シフトがカバーする時間帯
const SHIFT_COVERS = {
  '日勤':['morning','afternoon'],'日勤+':['morning','afternoon'],
  '午前':['morning'],'午後':['afternoon'],
  '遅番':['afternoon','evening'],'遅L':['afternoon','evening'],
  'リハ遅':['afternoon','evening'],'夜勤':['evening'],
  '長日':['morning','afternoon','evening'],'中抜け':['morning','evening'],
  '時短':['morning'],'CC':['morning','afternoon'],'CHO':['morning','afternoon'],
  'CCのみ':['afternoon'],'休み':[],'有休':[],'半有休':[],'個夏休':[],'希望休':[]
};

// 夜勤系シフト（起動時にDBから動的にリビルドされる）
const NIGHT_SHIFTS = ['遅番','遅L','リハ遅','夜勤'];
const LATE_SHIFTS = ['遅番','遅L','リハ遅'];
const LONG_SHIFTS = ['長日'];
const MID_BREAK_SHIFTS = ['中抜け'];
const OFF_SHIFTS = ['休み','有休','半有休','個夏休','希望休'];

// シフトタイプの動的ロード結果（フェーズ2で使用）
let shiftTypesAll = []; // 全シフト（is_off含む）
let shiftTypesActive = []; // 勤務シフトのみ（is_off=false）

// =====================================================
// 起動時にshift_typesテーブルから読み込み、互換マップを再構築
// 既存のSHIFT_HOURS, SHIFT_COVERS, NIGHT_SHIFTS等の中身を
// データベース内容で書き換える（カスタムシフト含む）
// =====================================================
async function loadShiftTypesAndBuildMaps() {
  try {
    const types = await sb('shift_types?order=display_order,id&select=*');
    shiftTypesAll = types;
    shiftTypesActive = types.filter(s => !s.is_off);

    // SHIFT_HOURS をクリアして再構築
    Object.keys(SHIFT_HOURS).forEach(k => delete SHIFT_HOURS[k]);
    types.forEach(s => {
      SHIFT_HOURS[s.id] = parseFloat(s.work_hours) || 0;
    });

    // SHIFT_COVERS をクリアして再構築
    Object.keys(SHIFT_COVERS).forEach(k => delete SHIFT_COVERS[k]);
    types.forEach(s => {
      const covers = [];
      if (s.covers_morning) covers.push('morning');
      if (s.covers_afternoon) covers.push('afternoon');
      if (s.covers_evening) covers.push('evening');
      SHIFT_COVERS[s.id] = covers;
    });

    // 各分類フラグ配列をクリアして再構築
    NIGHT_SHIFTS.length = 0;
    LATE_SHIFTS.length = 0;
    LONG_SHIFTS.length = 0;
    MID_BREAK_SHIFTS.length = 0;
    OFF_SHIFTS.length = 0;
    SHIFT_OPTIONS.length = 0;
    types.forEach(s => {
      if (s.is_night) NIGHT_SHIFTS.push(s.id);
      if (s.is_late) LATE_SHIFTS.push(s.id);
      if (s.is_long) LONG_SHIFTS.push(s.id);
      if (s.is_mid_break) MID_BREAK_SHIFTS.push(s.id);
      if (s.is_off) OFF_SHIFTS.push(s.id);
      // SHIFT_OPTIONS は表示順で全シフトを並べる（is_offも含む）
      SHIFT_OPTIONS.push(s.id);
    });

    // SHIFT_COLORS にカスタムシフトのデフォルトクラスを追加
    types.forEach(s => {
      if (!SHIFT_COLORS[s.id]) {
        // カスタムシフトは「sc-custom」クラスをデフォルトに
        SHIFT_COLORS[s.id] = 'sc-custom';
      }
    });

    // SHIFT_PATTERN_OPTIONS もリビルド（自動生成用のチェックボックス一覧）
    // CC/CHO/CCのみと休み系は除外（既存仕様）
    SHIFT_PATTERN_OPTIONS.length = 0;
    types.forEach(s => {
      if (s.is_off) return; // 休み系は除外
      if (['CC','CHO','CCのみ'].includes(s.id)) return; // CC/CHO関連は除外
      const time = (s.start_time && s.end_time) ? `${s.start_time}-${s.end_time}` : '';
      SHIFT_PATTERN_OPTIONS.push({ id: s.id, label: s.label || s.id, time: time });
    });

    console.log('[shift_types] ロード完了', {
      総数: types.length,
      勤務シフト: shiftTypesActive.length,
      休み系: OFF_SHIFTS.length,
      夜勤: NIGHT_SHIFTS,
      遅番: LATE_SHIFTS,
      長日: LONG_SHIFTS,
      中抜け: MID_BREAK_SHIFTS
    });
  } catch(e) {
    console.error('[shift_types] ロードエラー、ハードコード値を使用', e);
  }
}

// SUPABASE
async function sb(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.method === 'POST' ? 'return=representation' : '',
      ...options.headers,
    }
  });
  if (!res.ok) throw new Error(await res.text());
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

// 管理者APIヘルパー（accounts 系操作）
async function adminApi(endpoint, payload) {
  const token = localStorage.getItem('shift_admin_token') || '';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// UI
function showLoading() { document.getElementById('loading').style.display = 'flex'; }
function hideLoading() { document.getElementById('loading').style.display = 'none'; }
function showToast(msg, type='', duration=3000) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.className = 'toast', duration);
}
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function openModal(id) { document.getElementById(id).classList.add('show'); }

// LOGIN
// SHA-256ハッシュ関数
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 部門選択時に名前ドロップダウンを動的に取得
document.getElementById('adminDeptSelect').addEventListener('change', async (e) => {
  const deptVal = e.target.value;
  const nameSelect = document.getElementById('adminNameSelect');
  nameSelect.innerHTML = '<option value="">読み込み中...</option>';
  nameSelect.disabled = true;

  if (deptVal === '') {
    nameSelect.innerHTML = '<option value="">先に部門を選択してください</option>';
    return;
  }

  try {
    const deptIdToSend = (deptVal === 'null') ? null : parseInt(deptVal);
    const res = await fetch('/api/admin-names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deptId: deptIdToSend }),
    });
    const data = await res.json();
    const names = data.names || [];

    if (names.length === 0) {
      nameSelect.innerHTML = '<option value="">該当する管理者がいません</option>';
      nameSelect.disabled = true;
    } else {
      nameSelect.innerHTML = '<option value="">名前を選択</option>' +
        names.map(n => `<option value="${n}">${n}</option>`).join('');
      nameSelect.disabled = false;
    }
  } catch (err) {
    console.error('名前取得エラー:', err);
    nameSelect.innerHTML = '<option value="">読み込みに失敗しました</option>';
    nameSelect.disabled = true;
  }
});

document.getElementById('adminLoginBtn').addEventListener('click', async () => {
  const deptVal = document.getElementById('adminDeptSelect').value;
  const name = document.getElementById('adminNameSelect').value;
  const pw = document.getElementById('adminPassword').value;
  const errEl = document.getElementById('adminError');

  if (deptVal === '' || !name || !pw) {
    errEl.style.display='block';
    errEl.textContent='すべて選択・入力してください';
    return;
  }

  const deptId = (deptVal === 'null') ? null : parseInt(deptVal);

  showLoading();
  try {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'admin-login', deptId, name, password: pw }),
    });
    const data = await r.json();

    if (!r.ok) {
      errEl.style.display='block';
      errEl.textContent = data.error || '名前またはパスワードが正しくありません';
      hideLoading();
      return;
    }

    const account = data.user;
    localStorage.setItem('shift_admin_token', data.token);
    adminUser = {
      id: account.id,
      role: account.role,
      name: account.name,
      deptId: account.deptId,
      deptName: account.deptId !== null ? DEPT_NAMES[account.deptId] : '全部門',
    };
    currentDept = account.deptId ?? 0;

    errEl.style.display='none';
    // 権限制御：マスター = 全権、リーダー = スタッフ管理OK・アカウント管理NG
    const isMaster = account.role === 'master';
    const isLeader = account.role === 'leader';
    document.getElementById('staffNavItem').style.display = (isMaster || isLeader) ? 'flex' : 'none';
    document.getElementById('accountNavItem').style.display = isMaster ? 'flex' : 'none';
    document.getElementById('sidebarUserName').textContent = account.name;
    document.getElementById('sidebarUserRole').textContent =
      account.role === 'master' ? '管理者' :
      account.role === 'leader' ? `${adminUser.deptName} リーダー` : 'スタッフ';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    initApp();
  } catch(e) {
    console.error(e);
    errEl.style.display='block';
    errEl.textContent='接続エラーが発生しました';
  }
  hideLoading();
});

// Enterキーでログイン
document.getElementById('adminPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('adminLoginBtn').click();
});

// INIT
async function initApp() {
  showLoading();
  try {
    // ★ 所定算出の定数（short_ratio / default_planned_hours）をDBから先に読む
    await loadAppSettings();
    // 最初にshift_typesをロードして互換マップを構築（カスタムシフト対応）
    await loadShiftTypesAndBuildMaps();
    await loadStaff();
    updateMonthDisplays();
    buildAllDeptTabs();
    await loadShiftGrid();
  } catch(e) { console.error(e); showToast('初期化エラー','error'); }
  hideLoading();
}

async function loadStaff() {
  const f = adminUser.role === 'leader' ? `&dept_id=eq.${adminUser.deptId}` : '';
  allStaff = await sb(`staff?order=dept_id,display_order.asc.nullslast,staff_code${f}&select=id,staff_code,name,dept_id,emp_type,no_night,no_count,skill_level,fixed_shifts,display_order`);
}

function updateMonthDisplays() {
  // topbarMonth は金魚アニメーションに置き換えたので更新不要
  document.getElementById('reqMonthTitle').textContent = `${reqYear}年${reqMonth}月`;
  document.getElementById('shiftMonthTitle').textContent = `${shiftYear}年${shiftMonth}月`;
  document.getElementById('genMonthTitle').textContent = `${genYear}年${genMonth}月`;
  const dashTitle = document.getElementById('dashMonthTitle');
  if (dashTitle) dashTitle.textContent = `${dashYear}年${dashMonth}月`;
}

// DEPT TABS
function buildAllDeptTabs() {
  const depts = adminUser.role === 'master' ? DEPT_IDS : [adminUser.deptId];
  ['requestDeptTabs','shiftDeptTabs','genDeptTabs','staffDeptTabs','reqDeptTabs'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    depts.forEach(dId => {
      const btn = document.createElement('button');
      btn.className = `dept-tab${dId === currentDept ? ' active' : ''}`;
      btn.textContent = DEPT_NAMES[dId];
      btn.addEventListener('click', () => {
        // シフト表を見ている場合、切替前の状態をキャッシュ保存
        saveCurrentShiftStateToCache();
        currentDept = dId;
        document.querySelectorAll('.dept-tab').forEach(b => {
          const parent = b.closest('[id$="DeptTabs"]');
          if (parent) b.classList.toggle('active', DEPT_IDS.indexOf(dId) === [...parent.children].indexOf(b));
        });
        // 全タブ同期
        document.querySelectorAll('.dept-tab').forEach((b, _, arr) => {
          const siblings = [...b.parentElement.children];
          const idx = siblings.indexOf(b);
          b.classList.toggle('active', depts[idx] === dId);
        });
        refreshCurrentPage();
      });
      el.appendChild(btn);
    });
  });
}

// NAVIGATION
// サイドバー開閉（スマホ用ドロワー）
document.getElementById('sidebarToggle')?.addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
});
document.getElementById('sidebarBackdrop')?.addEventListener('click', () => {
  document.body.classList.remove('sidebar-open');
});

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    const titles = {dashboard:'ダッシュボード',requests:'希望一覧',shift:'シフト表',generate:'自動生成',settings:'設定',staff:'スタッフ管理',account:'アカウント管理',export:'エクスポート'};
    document.getElementById('topbarTitle').textContent = titles[page] || page;
    refreshCurrentPage();
    // スマホ：メニュー選択後はドロワーを閉じる
    if (window.matchMedia('(max-width:768px), (orientation:landscape) and (max-height:600px)').matches) document.body.classList.remove('sidebar-open');
  });
});

function refreshCurrentPage() {
  const active = document.querySelector('.page.active')?.id?.replace('page-','');
  if (active === 'dashboard') loadDashboard();
  else if (active === 'requests') loadRequests();
  else if (active === 'shift') {
    const ctx = `${currentDept}|${shiftYear}|${shiftMonth}`;
    // 同コンテキストならメモリ状態で再描画（shiftData空でもreqMapが有効なら反映される）
    if (shiftGridContext === ctx) {
      rerenderShiftGridFromMemory();
    }
    // 別コンテキストでも過去にキャッシュがあればそれを使う（月・部署切替時の未保存変更を復元）
    else if (tryRestoreShiftStateFromCache(ctx)) {
      rerenderShiftGridFromMemory();
    }
    // どちらもなければDBから新規読み込み
    else {
      loadShiftGrid();
    }
  }
  else if (active === 'generate') loadGenPage();
  else if (active === 'settings') loadSettings();
  else if (active === 'staff') loadStaffTable();
  else if (active === 'account') loadAccountPage();
  else if (active === 'export') loadExportPage();
}

// ===== DASHBOARD =====
async function loadDashboard() {
  const statsEl = document.getElementById('statsGrid');
  const submissionsEl = document.getElementById('recentSubmissions');

  // 明示的なローディング表示
  if (submissionsEl) {
    submissionsEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">
      <div style="display:inline-block;width:24px;height:24px;border:2px solid #e5e7eb;border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:10px"></div>
      <div>読み込み中...</div>
    </div>`;
  }

  try {
    // タイムアウト10秒
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('タイムアウト（10秒経過）')), 10000));
    const requestsPromise = sb(`shift_requests?year=eq.${dashYear}&month=eq.${dashMonth}&select=staff_id`);
    const requests = await Promise.race([requestsPromise, timeoutPromise]);

    const submittedIds = new Set(requests.map(r => r.staff_id));
    const total = allStaff.length;
    const submitted = allStaff.filter(s => submittedIds.has(s.id)).length;

    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat-card"><div class="stat-label">全スタッフ数</div><div class="stat-value">${total}</div><div class="stat-sub">全部門合計</div></div>
        <div class="stat-card"><div class="stat-label">希望提出済み</div><div class="stat-value" style="color:var(--success)">${submitted}</div><div class="stat-sub">${dashMonth}月</div></div>
        <div class="stat-card"><div class="stat-label">未提出</div><div class="stat-value" style="color:var(--warning)">${total-submitted}</div><div class="stat-sub">${dashMonth}月</div></div>
        <div class="stat-card"><div class="stat-label">提出率</div><div class="stat-value">${total > 0 ? Math.round(submitted/total*100) : 0}%</div><div class="stat-sub">${dashMonth}月</div></div>
      `;
    }

    const rows = allStaff.map(s => `<tr>
      <td>${escapeHtml(s.name)}</td><td>${DEPT_NAMES[s.dept_id]}</td>
      <td><span class="badge ${submittedIds.has(s.id) ? 'badge-submitted' : 'badge-pending'}">${submittedIds.has(s.id) ? '提出済み' : '未提出'}</span></td>
    </tr>`).join('');
    if (submissionsEl) {
      submissionsEl.innerHTML = `<table class="data-table"><thead><tr><th>名前</th><th>部門</th><th>状況</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
  } catch(e) {
    console.error('ダッシュボード読み込みエラー:', e);
    if (submissionsEl) {
      submissionsEl.innerHTML = `<div style="padding:24px;text-align:center">
        <div style="color:var(--danger);margin-bottom:8px;font-weight:600">読み込みに失敗しました</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${escapeHtml(e.message || 'ネットワークエラー')}</div>
        <button onclick="loadDashboard()" class="btn btn-primary" style="padding:8px 20px;font-size:13px">再読み込み</button>
      </div>`;
    }
    if (statsEl) statsEl.innerHTML = '';
  }
}

// ===== REQUESTS =====
async function loadRequests() {
  showLoading();
  try {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });
    if (!deptStaff.length) { hideLoading(); return; }
    const ids = deptStaff.map(s => `"${s.id}"`).join(',');
    const reqs = await sb(`shift_requests?staff_id=in.(${ids})&year=eq.${reqYear}&month=eq.${reqMonth}&select=staff_id,day,request_type,submitted_at`);
    const byStaff = {};
    deptStaff.forEach(s => { byStaff[s.id] = {staff:s, entries:[]}; });
    reqs.forEach(r => { if (byStaff[r.staff_id]) byStaff[r.staff_id].entries.push(r); });

    document.getElementById('requestsBody').innerHTML = Object.values(byStaff).map(({staff, entries}) => {
      const last = entries.length > 0 ? new Date(Math.max(...entries.map(e => new Date(e.submitted_at)))).toLocaleDateString('ja-JP') : '―';
      return `<tr>
        <td>${staff.name}</td><td>${DEPT_NAMES[staff.dept_id]}</td><td>${last}</td>
        <td>${entries.length}日</td>
        <td><span class="badge ${entries.length > 0 ? 'badge-submitted' : 'badge-pending'}">${entries.length > 0 ? '提出済み' : '未提出'}</span></td>
        <td><button class="btn btn-outline btn-sm" onclick="showRequestDetail('${staff.id}','${staff.name}')">詳細</button></td>
      </tr>`;
    }).join('');
  } catch(e) { console.error(e); showToast('読み込みエラー','error'); }
  hideLoading();
}

async function showRequestDetail(staffId, staffName) {
  showLoading();
  try {
    const reqs = await sb(`shift_requests?staff_id=eq.${staffId}&year=eq.${reqYear}&month=eq.${reqMonth}&order=day&select=day,request_type`);
    document.getElementById('requestDetailTitle').textContent = `${staffName} - ${reqYear}年${reqMonth}月`;
    const daysInMonth = new Date(reqYear, reqMonth, 0).getDate();
    const reqMap = {};
    reqs.forEach(r => { reqMap[r.day] = r.request_type; });
    let html = '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
    for (let d = 1; d <= daysInMonth; d++) {
      const shift = reqMap[d] || '';
      const dow = new Date(reqYear, reqMonth-1, d).getDay();
      const dowClass = dow===0?'color:#ef4444':dow===6?'color:#3b82f6':'';
      html += `<div style="width:48px;text-align:center">
        <div style="font-size:11px;${dowClass};margin-bottom:3px">${d}(${DOW[dow]})</div>
        <div class="shift-cell ${SHIFT_COLORS[shift]||''}" style="min-height:30px;font-size:10px;border-radius:6px">${shift||'―'}</div>
      </div>`;
    }
    html += '</div>';
    document.getElementById('requestDetailContent').innerHTML = html;
    document.getElementById('requestDetailModal').classList.add('show');
  } catch(e) { console.error(e); }
  hideLoading();
}

// ===== SHIFT GRID =====
let shiftGridRequirements = {};
let shiftGridPlanHours = 171.4;
let shiftGridStaffSettings = {};

async function loadShiftGrid() {
  showLoading();
  try {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });
    if (!deptStaff.length) { hideLoading(); return; }
    const ids = deptStaff.map(s => `"${s.id}"`).join(',');
    const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();

    const [existingShifts, requestData, requirements, monthlyHoursData, staffSettingsData, wedData, shiftSpecialDays, shiftThursdayData] = await Promise.all([
      sb(`shifts?staff_id=in.(${ids})&year=eq.${shiftYear}&month=eq.${shiftMonth}&select=staff_id,day,shift_type_id,is_locked,is_confirmed`),
      sb(`shift_requests?staff_id=in.(${ids})&year=eq.${shiftYear}&month=eq.${shiftMonth}&select=staff_id,day,request_type`),
      sb(`staffing_requirements?dept_id=eq.${currentDept}&select=period_id,day_type,min_count`),
      sb(`monthly_hours?month=eq.${shiftMonth}&year=eq.${shiftYear}&dept_id=is.null&select=hours`),
      sb(`staff_settings?staff_id=in.(${ids})&year=eq.${shiftYear}&month=eq.${shiftMonth}&select=staff_id,planned_hours`),
      sb(`wednesday_types?year=eq.${shiftYear}&month=eq.${shiftMonth}&select=day,wed_type`),
      sb(`special_days?year=eq.${shiftYear}&month=eq.${shiftMonth}&select=day,is_closed,is_holiday,label`),
      sb(`thursday_types?year=eq.${shiftYear}&month=eq.${shiftMonth}&select=day,is_open`)
    ]);

    // 木曜・祝日設定マップ
    const shiftClosedHolidays = new Set();
    const shiftCustomClosed = {}; // day -> label
    const jpHolidaysForShift = getJapaneseHolidays(shiftYear, shiftMonth);
    shiftSpecialDays.forEach(s => {
      if (!s.is_closed) return;
      // 祝日（カレンダー上の祝日 or is_holiday=true）→ 祝日休診
      // それ以外（is_holiday=false かつ 祝日でない）→ 任意休診日
      if (jpHolidaysForShift.has(s.day) || s.is_holiday === true) {
        shiftClosedHolidays.add(s.day);
      } else {
        shiftCustomClosed[s.day] = s.label || '休診';
      }
    });
    const shiftOpenThursdays = new Set();
    shiftThursdayData.forEach(t => { if(t.is_open) shiftOpenThursdays.add(t.day); });

    // shiftData・lockedCellsを今月のDB状態で完全に置き換える
    // ※過去：prevLockedCellsを引き継いでいたが、キーが staffId|day で年月情報を持たないため、
    //         月跨ぎでロックが伝播するバグの原因になっていた。
    //         未保存変更の保持は shiftMonthCache が担当するのでここでは不要。
    shiftData = {};
    lockedCells = {};
    existingShifts.forEach(s => {
      const key = `${s.staff_id}|${s.day}`;
      shiftData[key] = s.shift_type_id;
      if (s.is_locked) lockedCells[key] = true;
    });

    // ★ 確定ロック判定：is_confirmed=true のレコードが 1 件でもあればロック状態
    //   バナー表示と編集操作のブロックに使われる。
    isCurrentMonthConfirmed = existingShifts.some(s => s.is_confirmed === true);
    updateConfirmLockUI();

    // ★ 未選択セルのロックを cell_locks テーブルから復元
    //   shifts.is_locked はシフト選択済みセルのみ保持できるため、未選択セルのロックは別管理。
    //   テーブル未作成時は警告のみで処理継続（既存機能を壊さない）。
    try {
      const cellLocksData = await sb(`cell_locks?staff_id=in.(${ids})&year=eq.${shiftYear}&month=eq.${shiftMonth}&select=staff_id,day`);
      (cellLocksData || []).forEach(c => {
        const key = `${c.staff_id}|${c.day}`;
        lockedCells[key] = true;
      });
    } catch(e) {
      console.warn('cell_locks 読み込みスキップ（テーブル未作成の可能性）:', e);
    }

    const reqMap = {};
    requestData.forEach(r => { reqMap[`${r.staff_id}|${r.day}`] = r.request_type; });

    // 必要人数マップ
    shiftGridRequirements = {};
    requirements.forEach(r => {
      if (!shiftGridRequirements[r.period_id]) shiftGridRequirements[r.period_id] = {};
      shiftGridRequirements[r.period_id][r.day_type] = r.min_count;
    });

    // 所定時間
    shiftGridPlanHours = monthlyHoursData.length > 0 ? monthlyHoursData[0].hours : APP_DEFAULT_PLAN_HOURS;

    // スタッフ個別設定
    shiftGridStaffSettings = {};
    staffSettingsData.forEach(s => { shiftGridStaffSettings[s.staff_id] = s; });

    // 水曜種別
    const shiftWedTypes = {};
    wedData.forEach(w => { shiftWedTypes[w.day] = w.wed_type; });

    // shiftClosedHolidaysとshiftOpenThursdaysをグローバルに設定
    window._shiftClosedHolidays = shiftClosedHolidays;
    window._shiftOpenThursdays = shiftOpenThursdays;
    window._shiftCustomClosed = shiftCustomClosed;
    // AI適用時の再描画用に保持
    window._shiftReqMap = reqMap;
    window._shiftWedTypes = shiftWedTypes;
    renderShiftGrid('shiftGrid', deptStaff, daysInMonth, shiftYear, shiftMonth, shiftData, reqMap, lockedCells, true, shiftWedTypes);
    // コンテキストと保存スナップショットを更新（タブ切替時の状態保持・保存時点復元用）
    shiftGridContext = `${currentDept}|${shiftYear}|${shiftMonth}`;
    savedShiftSnapshot = {
      shiftData: JSON.parse(JSON.stringify(shiftData)),
      lockedCells: JSON.parse(JSON.stringify(lockedCells))
    };
    undoStack = [];
    redoStack = [];
  } catch(e) { console.error(e); showToast('シフト表読み込みエラー','error'); }
  hideLoading();
}

function renderShiftGrid(gridId, deptStaff, daysInMonth, year, month, shifts, reqMap, locked, editable, wedTypesMap) {
  const grid = document.getElementById(gridId);
  const holidays = getJapaneseHolidays(year, month);
  const wt = wedTypesMap || wedTypes || {};
  // 遅番系(遅番+遅L)・長日カウント列：編集グリッド かつ トグルON かつ 医療事務(dept0) のときのみ表示
  const showLateLong = editable && showLateLongCount && currentDept === 0;

  function getShiftDayType(d) {
    const dow = new Date(year, month-1, d).getDay();
    // 休診祝日
    const _closedH = (typeof shiftClosedHolidays !== 'undefined' ? shiftClosedHolidays : null) || window._shiftClosedHolidays || new Set();
    const _openThu = (typeof shiftOpenThursdays !== 'undefined' ? shiftOpenThursdays : null) || window._shiftOpenThursdays || new Set();
    const _customC = window._shiftCustomClosed || {};
    // 任意休診日（最優先：管理者が明示的に指定）
    if (_customC[d]) return 'clinic_closed';
    if (holidays.has(d) && _closedH.has(d)) return 'holiday_closed';
    if (holidays.has(d)) return 'holiday_jp';
    if (dow === 0 || dow === 6) return 'weekend';
    if (dow === 3) return wt[d] === 'cc' ? 'wed_cc' : wt[d] === 'cho' ? 'wed_cho' : 'wed_normal';
    // 木曜：デフォルト休診、診療日設定がある場合のみthu_open
    if (dow === 4) return _openThu.has(d) ? 'thu_open' : 'thu_closed';
    return 'weekday';
  }

  // 休診日種別判定ヘルパー
  function isClosedDayType(dt) {
    return dt === 'holiday_closed' || dt === 'thu_closed' || dt === 'clinic_closed';
  }

  function getReq(period, d) {
    const dt = getShiftDayType(d);
    // 休診日は必要人数0
    if (isClosedDayType(dt)) return 0;
    // 日付個別設定を優先
    const dayKey = `day_${year}_${month}_${d}`;
    if (shiftGridRequirements[period]?.[dayKey] !== undefined) {
      return shiftGridRequirements[period][dayKey];
    }
    return shiftGridRequirements[period]?.[dt] ?? null;
  }

  // ヘッダー行
  let html = '<thead><tr>';
  html += `<th class="staff-col" style="min-width:80px;padding:0;font-size:9px;color:var(--text-muted);text-align:center;line-height:1.4;white-space:nowrap">
    <div style="padding:4px 2px">
      <div style="font-weight:700;color:#475569">日</div>
      <div style="font-size:9px">クリックで詳細</div>
    </div>
    <div style="border-top:1px solid #cbd5e1;background:#f8fafc;padding:2px">
      ${editable
        ? `<button id="lockIconToggleBtn" onclick="toggleLockIcons()" title="氏名欄の行ロック鍵マーク🔒/🔓の表示/非表示を切り替えます（ロック状態自体は変わりません）" style="font-size:8px;padding:2px 5px;border:1px solid #cbd5e1;border-radius:4px;background:white;cursor:pointer;font-family:inherit;line-height:1.2;white-space:nowrap">🔒 ${hideLockIcons ? 'OFF' : 'ON'}</button>`
        : `<div style="font-size:9px">🔓=ロック</div>`}
    </div>
    ${editable && currentDept === 0
      ? `<div style="border-top:1px solid #e2e8f0;background:#f8fafc;padding:2px"><button onclick="toggleLateLongCount()" title="遅番系(遅番+遅L)と長日の月間回数を右端に表示します（医療事務のみ）" style="font-size:8px;padding:2px 5px;border:1px solid #cbd5e1;border-radius:4px;background:${showLateLongCount ? '#dbeafe' : 'white'};cursor:pointer;font-family:inherit;line-height:1.2;white-space:nowrap">遅長 ${showLateLongCount ? 'ON' : 'OFF'}</button></div>`
      : ''}
  </th>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month-1, d).getDay();
    const isHoliday = holidays.has(d);
    const dayType = getShiftDayType(d);
    const cls = (dow===0||isHoliday)?'day-sun':dow===6?'day-sat':'';
    const wedLabel = dow===3 ? (wt[d]==='cc'?'<div style="font-size:8px;color:#92400e;font-weight:700">CC</div>':wt[d]==='cho'?'<div style="font-size:8px;color:#5b21b6;font-weight:700">CHO</div>':'') : '';
    // 列ロック状態チェック
    const colLocked = editable && deptStaff.every(s => lockedCells[`${s.id}|${d}`]);
    const isClosedColumn = isClosedDayType(dayType);
    // 休診列は薄グレー、列ロックがあればそちらを優先
    let colStyle = '';
    if (colLocked) colStyle = 'background:#fef3c7;';
    else if (isClosedColumn) colStyle = 'background:#f3f4f6;';
    const dayType4header = getShiftDayType(d);
    const thuLabel = dow===4 ? (dayType4header==='thu_open'?'<div style="font-size:8px;color:#1d4ed8">診療</div>':'<div style="font-size:8px;color:#ef4444">休診</div>') : '';
    const holidayLabel = (holidays.has(d) && dayType4header==='holiday_closed') ? '<div style="font-size:8px;color:#6b7280">休診</div>' : '';
    const customClosedLabelText = (window._shiftCustomClosed || {})[d];
    const clinicClosedLabel = dayType4header === 'clinic_closed' ? `<div style="font-size:8px;color:#6b7280;line-height:1.2;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(customClosedLabelText || '休診')}">${escapeHtml(customClosedLabelText || '休診')}</div>` : '';
    if (editable) {
      html += `<th style="min-width:32px;padding:0;${colStyle}">
        <div class="day-header" style="display:flex;flex-direction:column">
          <div style="padding:4px 2px;cursor:pointer" onclick="openVerticalView(${d})" title="バーチカル表示">
            <div class="day-num ${cls}">${d}</div>
            <div class="day-dow ${cls}">${DOW[dow]}</div>
            ${wedLabel}${thuLabel}${holidayLabel}${clinicClosedLabel}
          </div>
          <div style="border-top:1px solid #cbd5e1;background:#f8fafc;padding:2px 0;cursor:pointer" onclick="toggleColumnLock(${d})" title="${colLocked?'列ロック解除':'列ロック'}">
            <div style="font-size:9px">${colLocked?'🔒':'<span style=\"color:#d1d5db\">🔓</span>'}</div>
          </div>
        </div>
      </th>`;
    } else {
      html += `<th style="min-width:32px;${colStyle}"><div class="day-header"><div class="day-num ${cls}" style="cursor:pointer" onclick="openVerticalView(${d})" title="バーチカル表示">${d}</div><div class="day-dow ${cls}" style="cursor:pointer" onclick="openVerticalView(${d})">${DOW[dow]}</div>${wedLabel}${thuLabel}${holidayLabel}${clinicClosedLabel}</div></th>`;
    }
  }
  if (editable) html += '<th style="min-width:160px;text-align:center;cursor:pointer" onclick="showMonthlyHoursEditor()">実働/所定 <span style="font-size:10px;opacity:0.6">✏️</span></th>';
  if (showLateLong) html += '<th style="min-width:78px;text-align:center;font-size:10px;color:#475569;line-height:1.3;white-space:nowrap">遅番系<br>/長日</th>';
  html += '</tr></thead><tbody>';

  // スタッフ行
  const staffTotalHours = {};
  deptStaff.forEach(staff => {
    let totalH = 0;
    let lateCnt = 0, longCnt = 0; // 遅番系(遅番+遅L)・長日の月間回数
    // 行ロック状態チェック
    const rowLocked = editable && Array.from({length:daysInMonth},(_,i)=>i+1).every(d => lockedCells[`${staff.id}|${d}`]);

    if (editable) {
      const rowLockStyle = rowLocked ? 'background:#fef9c3;' : '';
      // 属性表示：雇用形態ラベル(常勤/時短/パート)は作業領域確保のため非表示
      const empLabel = '';
      const skillLabel = staff.skill_level === 'beginner' ? '<span style="margin-left:2px;font-size:11px">🔰</span>'
        : staff.skill_level === 'no_count' ? '<span style="margin-left:2px;font-size:11px">🌸</span>'
        : '';
      html += `<tr style="${rowLockStyle}"><td class="staff-name" style="cursor:pointer;user-select:none;white-space:nowrap" onclick="toggleRowLock('${staff.id}',${daysInMonth})" title="${rowLocked?'行ロック解除':'行ロック'}">
        <span style="font-size:12px;font-weight:600">${staff.name}</span>${empLabel}${skillLabel}
        <span class="row-lock-icon" style="margin-left:4px;font-size:10px">${rowLocked?'🔒':'<span style=\"color:#d1d5db\">🔓</span>'}</span>
      </td>`;
    } else {
      html += `<tr><td class="staff-name">${staff.name}</td>`;
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${staff.id}|${d}`;
      const confirmedShift = shifts[key] || '';
      if (confirmedShift === '遅番' || confirmedShift === '遅L') lateCnt++; else if (confirmedShift === '長日') longCnt++;
      const requestedShift = reqMap[key] || '';
      const dispShift = confirmedShift || (editable ? '' : requestedShift);
      const isLocked = locked[key];
      const colorClass = SHIFT_COLORS[dispShift] || '';

      // 休診日判定：クリック不可・時間加算なし
      const cellDayType = getShiftDayType(d);
      if (isClosedDayType(cellDayType)) {
        if (editable) {
          html += `<td style="padding:2px;background:#f3f4f6">
            <div style="background:#f3f4f6;color:#cbd5e1;font-size:14px;text-align:center;height:36px;display:flex;align-items:center;justify-content:center;border-radius:4px">−</div>
          </td>`;
        } else {
          html += `<td style="background:#f3f4f6"><div style="min-height:20px"></div></td>`;
        }
        continue;
      }

      const shiftH = SHIFT_HOURS[confirmedShift] || 0;
      totalH += shiftH;
      // 有休/半有休の所定加算（有休は土日祝9H、平日8.5H）
      const dateOfDay = new Date(shiftYear, shiftMonth - 1, d);
      const dowOfDay = dateOfDay.getDay();
      const isHolidayOfDay = holidays.has(d);
      if (PAID_LEAVE_SHIFTS.includes(confirmedShift)) totalH += getYukyuHours(dowOfDay, isHolidayOfDay);
      if (confirmedShift === '半有休') totalH += 5;

      // 希望マーク：希望データがある日
      const hasRequest = !!requestedShift;
      const requestMismatch = hasRequest && confirmedShift && confirmedShift !== requestedShift;

      if (editable) {
        const lockBorder = isLocked ? 'box-shadow:inset 0 0 0 2px #f59e0b;' : '';
        const reqLabel = hasRequest ? `<div class="req-text" style="font-size:8px;color:#f59e0b;line-height:1;margin-top:1px;pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">⭐${requestedShift}</div>` : '';
        const lockIcon = isLocked ? `<span class="lock-icon" style="position:absolute;top:-3px;right:-3px;font-size:11px;line-height:1;z-index:2;pointer-events:none">🔒</span>` : '';
        html += `<td style="padding:2px;position:relative">
          <div class="shift-cell ${colorClass||'empty'}"
            data-staff="${staff.id}" data-day="${d}" data-grid="${gridId}"
            data-request="${requestedShift}"
            onclick="handleCellClick(event,'${staff.id}','${escapeJs(staff.name)}',${d},'${gridId}')"
            style="position:relative;cursor:pointer;${lockBorder};flex-direction:column;"
          ><span class="shift-text">${dispShift||'+'}</span>${reqLabel}${lockIcon}</div>
        </td>`;
      } else {
        html += `<td><div class="shift-cell ${colorClass||'empty'}" style="font-size:9px">${dispShift||''}</div></td>`;
      }
    }
    staffTotalHours[staff.id] = totalH;

    // 右端：労働時間列
    if (editable) {
      const setting = shiftGridStaffSettings[staff.id];
      const hasIndividual = setting?.planned_hours != null; // 個別設定の有無
      let planH = setting?.planned_hours ?? (
        staff.emp_type === 'full' ? shiftGridPlanHours :
        staff.emp_type === 'short' ? Math.round(shiftGridPlanHours * APP_SHORT_RATIO * 10)/10 : 0
      );
      const actual = Math.round(totalH * 10) / 10;
      const diff = Math.round((actual - planH) * 10) / 10;
      const diffStr = diff >= 0 ? `+${diff}H` : `${diff}H`;
      const workDays = Math.floor(actual / 8.5);
      const planDays = Math.floor(planH / 8.5);
      const color = planH <= 0 ? '#6b7280' : Math.abs(diff) <= 10 ? '#10b981' : diff > 10 ? '#f97316' : '#ef4444';
      // ★ 個別設定中は薄紫背景＋「基準値からの差」を表示
      const baseForType =
        staff.emp_type === 'full' ? shiftGridPlanHours :
        staff.emp_type === 'short' ? Math.round(shiftGridPlanHours * APP_SHORT_RATIO * 10)/10 : 0;
      const fromBase = Math.round((planH - baseForType) * 10) / 10;
      const fromBaseStr = hasIndividual
        ? `<span style="font-size:9px;color:#8b5cf6;font-weight:700"> (基準${fromBase >= 0 ? '+' : ''}${fromBase}H)</span>`
        : '';
      const cellBg = hasIndividual ? 'background:#f5f3ff;' : '';
      html += `<td style="white-space:nowrap;padding:4px 8px;font-size:11px;font-weight:600;color:${color};cursor:pointer;${cellBg}" onclick="showStaffHoursEditor('${staff.id}','${escapeJs(staff.name)}',${planH})">
        ${actual}H / ${planH}H（${diffStr}）${fromBaseStr}<br>
        <span style="font-size:10px;color:var(--text-muted)">${workDays}日 / ${planDays}日</span>
      </td>`;
    }
    if (showLateLong) {
      html += `<td style="text-align:center;white-space:nowrap;padding:4px 6px;font-size:12px;font-weight:700;line-height:1.4"><span style="color:#2563eb">遅 ${lateCnt}</span><br><span style="color:#b45309">長 ${longCnt}</span></td>`;
    }
    html += '</tr>';
  });

  // 充足状況行（セルクリックで日ごと個別編集）
  if (editable) {
    ['morning','afternoon','evening'].forEach((period, pi) => {
      const labels = ['午前帯','午後帯','夜間帯'];
      html += `<tr style="background:#f0f4f8"><td class="staff-name" style="font-size:11px;color:var(--text-muted);font-weight:700;cursor:pointer;user-select:none" onclick="showRequirementsEditor('${period}')" title="一括編集">${labels[pi]} ✏️</td>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const req = getReq(period, d);
        const dt = getShiftDayType(d);
        if (req === null) {
          html += `<td style="text-align:center;font-size:10px;color:#d1d5db;cursor:pointer" onclick="editSingleRequirement('${period}',${d},'${dt}',null)" title="${d}日 ${labels[pi]}を設定">—</td>`;
          continue;
        }
        const covered = deptStaff.filter(s => {
          if (s.skill_level === 'no_count' || s.no_count === true) return false;
          const shift = shifts[`${s.id}|${d}`];
          return shift && SHIFT_COVERS[shift]?.includes(period);
        }).length;
        const ok = covered >= req;
        const bg = req === 0 ? '#f3f4f6' : ok ? '#d1fae5' : '#fee2e2';
        const color = req === 0 ? '#9ca3af' : ok ? '#065f46' : '#be123c';
        html += `<td style="padding:2px 1px;cursor:pointer" onclick="editSingleRequirement('${period}',${d},'${dt}',${req})" title="${d}日 ${labels[pi]}: ${req}人">
          <div style="background:${bg};color:${color};font-size:10px;font-weight:700;border-radius:4px;padding:2px 0;text-align:center">
            ${req===0?'0':`${covered}/${req}`}
          </div>
        </td>`;
      }
      html += showLateLong ? '<td></td><td></td></tr>' : '<td></td></tr>';
    });
  }

  html += '</tbody>';
  grid.innerHTML = html;
  // 再描画後もロックアイコン表示状態を維持（編集グリッドのみ）
  if (gridId === 'shiftGrid') grid.classList.toggle('hide-lock-icons', hideLockIcons);
}

// シフト表セル内のロックアイコン🔒の表示/非表示をトグル（CSSクラスで切替＝再描画不要・ロック状態は不変）
function toggleLockIcons() {
  hideLockIcons = !hideLockIcons;
  const grid = document.getElementById('shiftGrid');
  if (grid) grid.classList.toggle('hide-lock-icons', hideLockIcons);
  const btn = document.getElementById('lockIconToggleBtn');
  if (btn) btn.textContent = `🔒 ${hideLockIcons ? 'OFF' : 'ON'}`;
}

// 遅番系(遅番+遅L)・長日の月間回数カウント列の表示トグル（医療事務のみ）。localStorageに永続化し再描画。
function toggleLateLongCount() {
  showLateLongCount = !showLateLongCount;
  try { localStorage.setItem('shift_late_long_count', showLateLongCount ? '1' : '0'); } catch(e) {}
  rerenderShiftGridFromMemory();
}


function handleCellClick(e, staffId, staffName, day, gridId) {
  // ★ 確定ロック中は編集ブロック（選択も含めて停止）
  if (!checkConfirmLock()) {
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  const shift = e.shiftKey;
  const key = `${staffId}|${day}`;

  if (ctrl) {
    // ⌘クリック：複数選択トグル
    e.stopPropagation();
    e.preventDefault();
    selectCell(staffId, day, 'toggle');
    return;
  }

  if (shift) {
    // Shiftクリック：範囲選択
    e.stopPropagation();
    e.preventDefault();
    // lastSelectedCellがない場合は単独選択として扱う
    if (!lastSelectedCell) {
      selectCell(staffId, day, 'single');
    } else {
      selectCell(staffId, day, 'range');
    }
    return;
  }

  // 通常クリック
  const alreadySelected = selectedCells.has(key);

  if (alreadySelected && selectedCells.size === 1) {
    // 同じセルを2回クリック → モーダルを開く
    openShiftEditModal(staffId, staffName, day, gridId);
  } else if (alreadySelected && selectedCells.size > 1) {
    // 複数選択中の選択済みセルをクリック → モーダルを開く（複数選択維持）
    openShiftEditModal(staffId, staffName, day, gridId);
  } else {
    // 別のセルをクリック → ハイライトのみ、lastSelectedCellを更新
    selectedCells.clear();
    selectCell(staffId, day, 'single');
  }
}

function openShiftEditModal(staffId, staffName, day, gridId) {
  const key = `${staffId}|${day}`;
  const date = new Date(shiftYear, shiftMonth-1, day);
  const isLocked = lockedCells[key];
  const multiLabel = selectedCells.size > 1 ? ` 他${selectedCells.size-1}セル` : '';
  document.getElementById('shiftEditTitle').textContent = `${staffName} - ${shiftMonth}月${day}日（${DOW[date.getDay()]}）${multiLabel}`;
  editingCell = { staffId, day, gridId, key };
  const opts = document.getElementById('shiftEditOptions');
  // SHIFT_INFO を shift_types テーブルから動的生成（カスタムシフト対応）
  const SHIFT_INFO = {};
  shiftTypesAll.forEach(s => {
    if (s.is_off) {
      // 休み系は時間表示なし、ただし有休・半有休・個夏休は所定時間扱いの説明あり
      if (s.id === '有休') SHIFT_INFO[s.id] = {time:'平日+8.5H / 土日祝+9H', hours:''};
      else if (s.id === '個夏休') SHIFT_INFO[s.id] = {time:'平日+8.5H / 土日祝+9H', hours:''};
      else if (s.id === '半有休') SHIFT_INFO[s.id] = {time:'所定+5H', hours:''};
      else SHIFT_INFO[s.id] = {time:'', hours:''};
    } else {
      const t = (s.start_time && s.end_time) ? `${s.start_time}-${s.end_time}` : '';
      const h = s.work_hours ? `${parseFloat(s.work_hours)}H` : '';
      SHIFT_INFO[s.id] = {time: t, hours: h};
    }
  });
  opts.innerHTML = SHIFT_OPTIONS.map(s => {
    const cur = shiftData[key];
    const info = SHIFT_INFO[s] || {};
    const isSelected = cur === s;
    return `<div class="shift-cell ${SHIFT_COLORS[s]||''}" 
      style="cursor:pointer;padding:10px 8px;border-radius:10px;flex-direction:column;min-height:56px;
      ${isSelected?'outline:2.5px solid var(--primary);box-shadow:0 0 0 3px rgba(15,76,129,0.1);':''}" 
      onclick="applyShiftEdit('${s}')">
      <span style="font-size:13px;font-weight:700;line-height:1.2">${s}</span>
      ${info.time ? `<span style="font-size:9px;opacity:0.7;margin-top:2px;line-height:1">${info.time}</span>` : ''}
      ${info.hours ? `<span style="font-size:10px;font-weight:600;opacity:0.85;margin-top:1px">${info.hours}</span>` : ''}
    </div>`;
  }).join('');
  document.getElementById('clearShiftBtn').textContent = isLocked ? '🔓 ロック解除' : '🔒 ロックする';
  document.getElementById('clearShiftBtn').onclick = () => toggleLock(key);
  document.getElementById('shiftEditModal').classList.add('show');
}

function applyShiftEdit(shiftId) {
  if (!editingCell) return;
  if (selectedCells.size > 1) {
    applyShiftToSelected(shiftId);
    closeModal('shiftEditModal');
    showToast(`${selectedCells.size}セルに「${shiftId}」を適用しました ✓`, 'success');
    return;
  }
  const { staffId, day, gridId, key } = editingCell;
  saveUndoState();
  shiftData[key] = shiftId;
  const key2 = `${staffId}|${day}`;
  updateCellDisplay(key2);
  refreshSummaryRows();
  refreshHoursCell(staffId);
  closeModal('shiftEditModal');
}

function toggleLock(key) {
  // ★ 確定ロック中はロック切替もブロック
  if (!checkConfirmLock()) return;
  saveUndoState();
  if (lockedCells[key]) {
    delete lockedCells[key];
    showToast('ロックを解除しました');
  } else {
    lockedCells[key] = true;
    showToast('ロックしました 🔒');
  }
  closeModal('shiftEditModal');
  updateCellDisplay(key);
}


function showRequestTooltip(el, requestedShift) {
  // 既存のツールチップを削除
  document.querySelectorAll('.req-tooltip').forEach(t => t.remove());
  const tip = document.createElement('div');
  tip.className = 'req-tooltip';
  tip.style.cssText = 'position:fixed;background:#1a2332;color:white;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:600;z-index:9999;pointer-events:none;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
  tip.textContent = `希望: ${requestedShift}`;
  document.body.appendChild(tip);
  const rect = el.getBoundingClientRect();
  tip.style.left = `${rect.left - tip.offsetWidth/2}px`;
  tip.style.top = `${rect.top - tip.offsetHeight - 6}px`;
  setTimeout(() => tip.remove(), 2000);
}


// シフトデータからセルのみ再描画（DB読み込みなし）
function rebuildShiftCells() {
  const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
  const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
  deptStaff.forEach(staff => {
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${staff.id}|${d}`;
      updateCellDisplay(key);
    }
  });
  refreshSummaryRows();
  highlightSelected();
}



// 右端の労働時間列をリアルタイム更新
function refreshHoursCell(staffId) {
  const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
  const staff = allStaff.find(s => s.id === staffId);
  if (!staff) return;

  // 累計時間を再計算
  const holidaysForCalc = getJapaneseHolidays(shiftYear, shiftMonth);
  let totalH = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const shift = shiftData[`${staffId}|${d}`] || '';
    totalH += SHIFT_HOURS[shift] || 0;
    if (PAID_LEAVE_SHIFTS.includes(shift)) {
      const dt = new Date(shiftYear, shiftMonth - 1, d);
      totalH += getYukyuHours(dt.getDay(), holidaysForCalc.has(d));
    }
    if (shift === '半有休') totalH += 5;
  }

  // 所定時間を取得
  const setting = shiftGridStaffSettings[staffId];
  const hasIndividual = setting?.planned_hours != null; // 個別設定の有無
  let planH = setting?.planned_hours ?? (
    staff.emp_type === 'full' ? shiftGridPlanHours :
    staff.emp_type === 'short' ? Math.round(shiftGridPlanHours * APP_SHORT_RATIO * 10)/10 : 0
  );

  const actual = Math.round(totalH * 10) / 10;
  const diff = Math.round((actual - planH) * 10) / 10;
  const diffStr = diff >= 0 ? `+${diff}H` : `${diff}H`;
  const workDays = Math.floor(actual / 8.5);
  const planDays = Math.floor(planH / 8.5);
  const color = planH <= 0 ? '#6b7280' : Math.abs(diff) <= 10 ? '#10b981' : diff > 10 ? '#f97316' : '#ef4444';
  // ★ 個別設定中は薄紫背景＋「基準値からの差」を表示
  const baseForType =
    staff.emp_type === 'full' ? shiftGridPlanHours :
    staff.emp_type === 'short' ? Math.round(shiftGridPlanHours * APP_SHORT_RATIO * 10)/10 : 0;
  const fromBase = Math.round((planH - baseForType) * 10) / 10;
  const fromBaseStr = hasIndividual
    ? `<span style="font-size:9px;color:#8b5cf6;font-weight:700"> (基準${fromBase >= 0 ? '+' : ''}${fromBase}H)</span>`
    : '';

  // 該当行の最後のtdを更新
  const rows = document.querySelectorAll('#shiftGrid tbody tr');
  const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
  const rowIdx = deptStaff.findIndex(s => s.id === staffId);
  if (rowIdx === -1) return;
  const row = rows[rowIdx];
  if (!row) return;
  const lastTd = row.querySelector('td:last-child');
  if (!lastTd) return;

  lastTd.style.color = color;
  lastTd.style.background = hasIndividual ? '#f5f3ff' : '';
  lastTd.innerHTML = `${actual}H / ${planH}H（${diffStr}）${fromBaseStr}<br>
    <span style="font-size:10px;color:var(--text-muted)">${workDays}日 / ${planDays}日</span>`;
}

function updateCellDisplay(key) {
  const [staffId, day] = parseKey(key);
  const el = getCellEl(staffId, day);
  if (!el) return;

  const shift = shiftData[key] || '';
  const isLocked = !!lockedCells[key];

  // セル色更新
  el.className = `shift-cell ${SHIFT_COLORS[shift]||'empty'}`;
  // ロック枠更新
  el.style.boxShadow = isLocked ? 'inset 0 0 0 2px #f59e0b' : '';

  // shift-textを更新（なければ作る）
  let shiftSpan = el.querySelector('.shift-text');
  if (!shiftSpan) {
    // 古い形式のspanを全て削除
    el.querySelectorAll('span').forEach(s => s.remove());
    shiftSpan = document.createElement('span');
    shiftSpan.className = 'shift-text';
    el.insertBefore(shiftSpan, el.firstChild);
  }
  shiftSpan.textContent = shift || '+';

  // lock-iconを更新
  let lockEl = el.querySelector('.lock-icon');
  if (isLocked) {
    if (!lockEl) {
      lockEl = document.createElement('span');
      lockEl.className = 'lock-icon';
      lockEl.style.cssText = 'position:absolute;top:-3px;right:-3px;font-size:11px;line-height:1;z-index:2;pointer-events:none';
      el.appendChild(lockEl);
    }
    lockEl.textContent = '🔒';
  } else {
    if (lockEl) lockEl.remove();
  }
}

function escapeJs(str) { return str.replace(/'/g, "\'"); }

// 列ロック（日ごと全スタッフ）
function toggleColumnLock(day) {
  saveUndoState();
  const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
  const allLocked = deptStaff.every(s => lockedCells[`${s.id}|${day}`]);
  deptStaff.forEach(s => {
    const key = `${s.id}|${day}`;
    if (allLocked) delete lockedCells[key];
    else lockedCells[key] = true;
  });
  showToast(allLocked ? `${day}日のロックを解除` : `${day}日をロック 🔒`);
  // メモリ上の現在状態で再描画（DB再取得しない）
  rerenderShiftGridFromMemory();
}

// 行ロック（スタッフごと全日）
function toggleRowLock(staffId, daysInMonth) {
  saveUndoState();
  const allLocked = Array.from({length:daysInMonth},(_,i)=>i+1).every(d => lockedCells[`${staffId}|${d}`]);
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${staffId}|${d}`;
    if (allLocked) delete lockedCells[key];
    else lockedCells[key] = true;
  }
  showToast(allLocked ? 'ロックを解除しました' : '行全体をロックしました 🔒');
  // メモリ上の現在状態で再描画（DB再取得しない）
  rerenderShiftGridFromMemory();
}

// 現在のメモリ状態（shiftData, lockedCells）で再描画。DB再取得しない
function rerenderShiftGridFromMemory() {
  const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
    const aOrder = a.display_order ?? 99999;
    const bOrder = b.display_order ?? 99999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.staff_code - b.staff_code;
  });
  if (!deptStaff.length) return;
  const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
  const reqMap = window._shiftReqMap || {};
  const wedTypesMap = window._shiftWedTypes || {};
  renderShiftGrid('shiftGrid', deptStaff, daysInMonth, shiftYear, shiftMonth, shiftData, reqMap, lockedCells, true, wedTypesMap);
}

// ===== 確定ロック関連 =====

// 確定ロックバナーの表示／非表示を切り替え
function updateConfirmLockUI() {
  const banner = document.getElementById('confirmLockBanner');
  if (banner) banner.style.display = isCurrentMonthConfirmed ? 'block' : 'none';
  // 確定ボタンの状態を切り替え
  const confirmBtn = document.getElementById('confirmShiftBtn');
  if (confirmBtn) {
    if (isCurrentMonthConfirmed) {
      // 確定済み：ボタンは表示するが無効化（取り消しはバナー経由）
      confirmBtn.textContent = '✅ 確定済み';
      confirmBtn.disabled = true;
      confirmBtn.style.opacity = '0.6';
      confirmBtn.style.cursor = 'not-allowed';
      confirmBtn.title = '確定済み・変更するにはバナーの「確定を取り消して編集する」を押してください';
    } else {
      // 未確定：通常通り有効化
      confirmBtn.textContent = '✅ 確定する';
      confirmBtn.disabled = false;
      confirmBtn.style.opacity = '';
      confirmBtn.style.cursor = '';
      confirmBtn.title = '';
    }
  }
  const badge = document.getElementById('confirmStatusBadge');
  if (badge) {
    if (isCurrentMonthConfirmed) {
      badge.style.display = 'block';
      badge.style.background = '#d1fae5';
      badge.style.color = '#065f46';
      badge.textContent = '📢 公開中';
    } else {
      badge.style.display = 'none';
    }
  }
}

// 編集操作の前に呼ぶ：確定ロック中なら警告を出して false を返す
function checkConfirmLock() {
  if (isCurrentMonthConfirmed) {
    alert(
      '【操作不可】\n\n' +
      `${DEPT_NAMES[currentDept] || ''} ${shiftYear}年${shiftMonth}月のシフト表は確定済み・スタッフに公開中です。\n` +
      '変更するには、シフト表上部の「確定を取り消して編集する」を押してから操作してください。'
    );
    return false;
  }
  return true;
}

// 確定を取り消す（current dept / shiftYear / shiftMonth のみ）
async function unconfirmCurrentMonth() {
  const deptLabel = DEPT_NAMES[currentDept] || `部署${currentDept}`;
  if (!confirm(
    `${deptLabel} ${shiftYear}年${shiftMonth}月のシフト確定を取り消しますか？\n\n` +
    '・スタッフへの公開が停止されます\n' +
    '・編集可能な状態に戻ります\n' +
    '・編集後は再度「確定する」を押して公開してください'
  )) return;

  showLoading();
  try {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
    const ids = deptStaff.map(s => `"${s.id}"`).join(',');
    if (ids) {
      await sb(
        `shifts?staff_id=in.(${ids})&year=eq.${shiftYear}&month=eq.${shiftMonth}&is_confirmed=eq.true`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ is_confirmed: false })
        }
      );
    }
    isCurrentMonthConfirmed = false;
    updateConfirmLockUI();
    showToast('確定を取り消しました。編集可能になりました ✓', 'success');
  } catch (e) {
    console.error(e);
    showToast('取り消しエラー', 'error');
  }
  hideLoading();
}

// バナーのボタンを wire up
document.getElementById('unconfirmBtn')?.addEventListener('click', unconfirmCurrentMonth);

// 期間内に確定済みの月があるかチェック（固定シフト一括操作用）
// 確定済みがあれば alert を出して false、無ければ true を返す
async function checkRangeNotConfirmed(deptId, startYear, startMonth, endYear, endMonth) {
  const deptStaff = allStaff.filter(s => s.dept_id === deptId);
  const ids = deptStaff.map(s => `"${s.id}"`).join(',');
  if (!ids) return true;
  const confirmedShifts = await sb(`shifts?staff_id=in.(${ids})&is_confirmed=eq.true&select=year,month`);
  const startKey = startYear * 100 + startMonth;
  const endKey = endYear * 100 + endMonth;
  const inRange = (confirmedShifts || []).filter(s => {
    const ymKey = s.year * 100 + s.month;
    return ymKey >= startKey && ymKey <= endKey;
  });
  if (inRange.length > 0) {
    const months = [...new Set(inRange.map(s => `${s.year}/${s.month}`))];
    alert(
      '【操作不可】\n\n' +
      '以下の月は確定済み・スタッフに公開中です：\n' +
      `${months.join(', ')}\n\n` +
      'シフト表タブで該当月を表示し、\n' +
      '「確定を取り消して編集する」を押してから再度実行してください。'
    );
    return false;
  }
  return true;
}

// 設定変更（所定労働時間・必要人数）の事前チェック
// 自動生成プレビュー中のみブロック。それ以外は通過させ、
// シフトデータ（手動編集・ロック・選択状態）はメモリのまま保持する。
// 戻り値：true = 設定変更を続行可、false = 中止
async function preFlightCheckForSettingsChange() {
  // 確定ロック中はブロック
  if (!checkConfirmLock()) return false;
  // 自動生成プレビュー中の場合はブロック
  if (Object.keys(generatedShifts).length > 0) {
    alert(
      '【操作不可】\n\n' +
      '自動生成プレビューが表示中です。\n' +
      '設定変更前にシフト表上部のバナーで「確定」または「生成前に戻す」を押してください。'
    );
    return false;
  }
  return true;
}

// 所定労働時間クイック編集
function showMonthlyHoursEditor() {
  const cur = shiftGridPlanHours;
  const val = prompt(`${shiftYear}年${shiftMonth}月の所定労働時間を入力してください（現在: ${cur}H）`, cur);
  if (val === null) return;
  const newH = parseFloat(val);
  if (isNaN(newH) || newH <= 0) { showToast('正しい時間を入力してください', 'error'); return; }
  saveMonthlyHours(newH);
}

async function saveMonthlyHours(hours) {
  // ★ 事前チェック：自動生成プレビュー中はブロック
  if (!(await preFlightCheckForSettingsChange())) return;
  showLoading();
  try {
    await sb(`monthly_hours?year=eq.${shiftYear}&month=eq.${shiftMonth}&dept_id=is.null`, {method:'DELETE'});
    await sb('monthly_hours', {method:'POST', body:JSON.stringify([{year:shiftYear,month:shiftMonth,hours,dept_id:null}])});
    shiftGridPlanHours = hours;
    showToast(`所定労働時間を${hours}Hに更新しました ✓`, 'success');
    // ★ メモリ保持で再描画（loadShiftGrid は呼ばない）
    //   手動編集、ロック、選択状態はすべてメモリのまま維持される。
    //   AI プレビュー残骸の問題は preFlightCheck で構造的に防止されている。
    rerenderShiftGridFromMemory();
  } catch(e) { showToast('保存エラー','error'); }
  hideLoading();
}


// 日ごと個別必要人数編集
async function editSingleRequirement(period, day, dayType, currentReq) {
  const labels = {morning:'午前帯',afternoon:'午後帯',evening:'夜間帯'};
  const dow = new Date(shiftYear, shiftMonth-1, day).getDay();
  const DOW_JP = ['日','月','火','水','木','金','土'];
  const val = prompt(`${shiftMonth}月${day}日（${DOW_JP[dow]}）${labels[period]}の必要人数\n現在: ${currentReq !== null ? currentReq+'人' : '未設定'}\n（空欄=曜日別設定に従う）`, currentReq !== null ? currentReq : '');
  if (val === null) return;
  
  // ★ 事前チェック：自動生成プレビュー中はブロック
  if (!(await preFlightCheckForSettingsChange())) return;
  
  showLoading();
  try {
    const dayKey = `day_${shiftYear}_${shiftMonth}_${day}`;
    if (val.trim() === '') {
      // 日付個別設定を削除（曜日別に戻す）
      await sb(`staffing_requirements?dept_id=eq.${currentDept}&period_id=eq.${period}&day_type=eq.${dayKey}`, {method:'DELETE'});
      // ★ ローカルからも個別設定を削除（旧コードはloadShiftGrid再取得に依存していた）
      if (shiftGridRequirements[period]) delete shiftGridRequirements[period][dayKey];
      showToast(`${day}日の個別設定を削除しました`);
    } else {
      const newReq = parseInt(val);
      if (isNaN(newReq) || newReq < 0) { showToast('正しい人数を入力してください','error'); hideLoading(); return; }
      // 日付個別キーで保存
      await sb(`staffing_requirements?dept_id=eq.${currentDept}&period_id=eq.${period}&day_type=eq.${dayKey}`, {method:'DELETE'});
      await sb('staffing_requirements', {method:'POST', body:JSON.stringify([{dept_id:currentDept, period_id:period, day_type:dayKey, min_count:newReq}])});
      // ローカルに反映
      if (!shiftGridRequirements[period]) shiftGridRequirements[period] = {};
      shiftGridRequirements[period][dayKey] = newReq;
      showToast(`${day}日 ${labels[period]}を${newReq}人に設定しました ✓`, 'success');
    }
    // ★ メモリ保持で再描画（loadShiftGrid は呼ばない）
    //   手動編集、ロック、選択状態を維持。AI プレビュー中は preFlightCheck でブロック済み。
    rerenderShiftGridFromMemory();
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
}

// スタッフ個別所定時間編集
function showStaffHoursEditor(staffId, staffName, currentPlan) {
  const val = prompt(`${staffName}の所定労働時間を入力（現在: ${currentPlan}H）\n空欄でデフォルトに戻す`, currentPlan || '');
  if (val === null) return;
  const newH = val.trim() === '' ? null : parseFloat(val);
  if (val.trim() !== '' && (isNaN(newH) || newH < 0)) { showToast('正しい時間を入力してください','error'); return; }
  saveStaffHours(staffId, staffName, newH);
}

async function saveStaffHours(staffId, staffName, hours) {
  // ★ 事前チェック：自動生成プレビュー中はブロック
  if (!(await preFlightCheckForSettingsChange())) return;

  // ★ 入力値が基準値と同じ場合は個別設定を作らずクリアする
  //   （個別設定が基準値と同値だと、基準値変更時に追従しない問題を防ぐ）
  const staff = allStaff.find(s => s.id === staffId);
  if (hours !== null && staff) {
    const baseForType =
      staff.emp_type === 'full' ? shiftGridPlanHours :
      staff.emp_type === 'short' ? Math.round(shiftGridPlanHours * APP_SHORT_RATIO * 10) / 10 :
      0;
    if (Math.abs(hours - baseForType) < 0.05) {
      hours = null; // 基準値と同じ → 個別設定をクリア扱いにする
      showToast(`基準値（${baseForType}H）と同じため、個別設定をクリアします`, 'info');
    }
  }

  showLoading();
  try {
    await sb(`staff_settings?staff_id=eq.${staffId}&year=eq.${shiftYear}&month=eq.${shiftMonth}`, {method:'DELETE'});
    if (hours !== null) {
      await sb('staff_settings', {method:'POST', body:JSON.stringify([{staff_id:staffId, year:shiftYear, month:shiftMonth, planned_hours:hours}])});
    }
    // ★ ローカルにも反映（旧コードはloadShiftGrid再取得に依存していた）
    if (hours !== null) {
      shiftGridStaffSettings[staffId] = { staff_id: staffId, planned_hours: hours };
    } else {
      delete shiftGridStaffSettings[staffId];
    }
    showToast(`${staffName}の所定時間を更新しました ✓`, 'success');
    // ★ メモリ保持で再描画（loadShiftGrid は呼ばない）
    //   手動編集、ロック、選択状態を維持。AI プレビュー中は preFlightCheck でブロック済み。
    rerenderShiftGridFromMemory();
  } catch(e) { showToast('保存エラー','error'); }
  hideLoading();
}

// 必要人数クイック編集
function showRequirementsEditor(period) {
  const labels = {morning:'午前帯',afternoon:'午後帯',evening:'夜間帯'};
  const dayTypes = ['weekday','wed_normal','wed_cc','wed_cho','weekend','thu_open','holiday_jp'];
  const dayLabels = {weekday:'月火金',wed_normal:'水(通常)',wed_cc:'水(CC)',wed_cho:'水(CHO)',weekend:'土日',thu_open:'木(診療)',holiday_jp:'祝日'};
  let msg = `${labels[period]}の必要人数を入力\n`;
  dayTypes.forEach(dt => {
    const cur = shiftGridRequirements[period]?.[dt] ?? '';
    msg += `${dayLabels[dt]}: `;
  });
  // 簡易モーダルで編集
  document.getElementById('requirementsQuickModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'requirementsQuickModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `<div style="background:white;border-radius:16px;padding:24px;min-width:360px;max-width:480px">
    <div style="font-size:16px;font-weight:700;margin-bottom:16px">${labels[period]}の必要人数編集</div>
    ${dayTypes.map(dt => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e2e8f0">
        <span style="font-size:14px">${dayLabels[dt]}</span>
        <input type="number" id="qreq-${period}-${dt}" value="${shiftGridRequirements[period]?.[dt]??''}" min="0" max="50" 
          style="width:60px;padding:6px;border:1.5px solid #e2e8f0;border-radius:6px;text-align:center;font-size:14px">
      </div>
    `).join('')}
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button onclick="document.getElementById('requirementsQuickModal').remove()" 
        style="padding:10px 16px;border:1.5px solid #e2e8f0;border-radius:8px;background:white;cursor:pointer;font-family:inherit">キャンセル</button>
      <button onclick="saveRequirementsQuick('${period}')"
        style="padding:10px 16px;background:#0f4c81;color:white;border:none;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600">保存</button>
    </div>
  </div>`;
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function saveRequirementsQuick(period) {
  // ★ 事前チェック：自動生成プレビュー中はブロック
  if (!(await preFlightCheckForSettingsChange())) return;
  showLoading();
  try {
    const dayTypes = ['weekday','wed_normal','wed_cc','wed_cho','weekend','thu_open','holiday_jp'];
    // ★ 曜日別キーのみDELETE（day_YYYY_M_D の日別個別設定は残す）
    //   旧コードは period_id 単位で全削除していたため、曜日別一括保存を押すと
    //   editSingleRequirement で設定した日別個別設定まで消えるバグがあった。
    const inList = dayTypes.map(d => `"${d}"`).join(',');
    await sb(`staffing_requirements?dept_id=eq.${currentDept}&period_id=eq.${period}&day_type=in.(${inList})`, {method:'DELETE'});
    const inserts = [];
    dayTypes.forEach(dt => {
      const el = document.getElementById(`qreq-${period}-${dt}`);
      if (el && el.value !== '') inserts.push({dept_id:currentDept, period_id:period, day_type:dt, min_count:parseInt(el.value)});
    });
    if (inserts.length > 0) await sb('staffing_requirements', {method:'POST', body:JSON.stringify(inserts)});
    // ★ ローカル：曜日別キーのみクリア（日別個別 day_YYYY_M_D は保持）
    if (!shiftGridRequirements[period]) shiftGridRequirements[period] = {};
    dayTypes.forEach(dt => { delete shiftGridRequirements[period][dt]; });
    dayTypes.forEach(dt => {
      const el = document.getElementById(`qreq-${period}-${dt}`);
      if (el && el.value !== '') shiftGridRequirements[period][dt] = parseInt(el.value);
    });
    document.getElementById('requirementsQuickModal')?.remove();
    showToast('必要人数を保存しました ✓', 'success');
    // ★ メモリ保持で再描画（loadShiftGrid は呼ばない）
    //   手動編集、ロック、選択状態を維持。AI プレビュー中は preFlightCheck でブロック済み。
    rerenderShiftGridFromMemory();
  } catch(e) { showToast('保存エラー','error'); }
  hideLoading();
}

// ===== CELL SELECTION & SHORTCUT SYSTEM =====
let selectedCells = new Set();
let lastSelectedCell = null;
let clipboard = null;
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 50;

function getCellEl(staffId, day) {
  return document.querySelector(`[data-staff="${staffId}"][data-day="${day}"][data-grid="shiftGrid"]`);
}

function parseKey(key) {
  const idx = key.lastIndexOf('|');
  return [key.substring(0, idx), key.substring(idx+1)];
}

function highlightSelected() {
  // 全セルのハイライトをリセット
  document.querySelectorAll('[data-grid="shiftGrid"]').forEach(el => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.zIndex = '';
    el.classList.remove('cell-selected');
  });
  // 選択セルをハイライト
  selectedCells.forEach(key => {
    const [sid, d] = parseKey(key);
    const el = getCellEl(sid, d);
    if (el) {
      el.style.outline = '3px solid #0f4c81';
      el.style.outlineOffset = '-1px';
      el.style.zIndex = '10';
      el.classList.add('cell-selected');
    }
  });
}

function selectCell(staffId, day, mode) {
  const key = `${staffId}|${day}`;
  if (mode === 'toggle') {
    if (selectedCells.has(key)) selectedCells.delete(key);
    else selectedCells.add(key);
    lastSelectedCell = {staffId, day: parseInt(day)};
  } else if (mode === 'range' && lastSelectedCell) {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });
    const staffIds = deptStaff.map(s => s.id);
    const si1 = staffIds.indexOf(lastSelectedCell.staffId);
    const si2 = staffIds.indexOf(staffId);
    const d1 = parseInt(lastSelectedCell.day);
    const d2 = parseInt(day);
    console.log('range: si1=',si1,'si2=',si2,'d1=',d1,'d2=',d2);
    if (si1 === -1 || si2 === -1) {
      // staffIdが見つからない場合は単独選択
      selectedCells.clear();
      selectedCells.add(`${staffId}|${day}`);
      lastSelectedCell = {staffId, day: parseInt(day)};
    } else {
      const minSi = Math.min(si1,si2), maxSi = Math.max(si1,si2);
      const minD = Math.min(d1,d2), maxD = Math.max(d1,d2);
      for (let si = minSi; si <= maxSi; si++) {
        for (let d = minD; d <= maxD; d++) {
          selectedCells.add(`${staffIds[si]}|${d}`);
        }
      }
    }
  } else {
    selectedCells.clear();
    selectedCells.add(key);
    lastSelectedCell = {staffId, day: parseInt(day)};
  }
  // 少し遅延してハイライト（DOM更新後に実行）
  requestAnimationFrame(() => highlightSelected());
}

function saveUndoState() {
  undoStack.push({
    shiftData: JSON.parse(JSON.stringify(shiftData)),
    lockedCells: JSON.parse(JSON.stringify(lockedCells))
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}

function applyShiftToSelected(shiftId) {
  if (selectedCells.size === 0) return;
  saveUndoState();
  selectedCells.forEach(key => {
    if (lockedCells[key]) return;
    if (shiftId === null) delete shiftData[key];
    else shiftData[key] = shiftId;
    const [sid, d] = parseKey(key);
    updateCellDisplay(key);
  });
  refreshSummaryRows();
}

function refreshSummaryRows() {
  const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
  const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
  const holidays = getJapaneseHolidays(shiftYear, shiftMonth);
  const wt = wedTypes || {};
  function getShiftDayType(d) {
    const dow = new Date(shiftYear, shiftMonth-1, d).getDay();
    if (holidays.has(d)) return 'holiday_jp';
    if (dow===0||dow===6) return 'weekend';
    if (dow===3) return wt[d]==='cc'?'wed_cc':wt[d]==='cho'?'wed_cho':'wed_normal';
    if (dow===4) return 'thu_open';
    return 'weekday';
  }
  ['morning','afternoon','evening'].forEach((period, pi) => {
    const rows = document.querySelectorAll('#shiftGrid tbody tr');
    const summaryRow = rows[deptStaff.length + pi];
    if (!summaryRow) return;
    const cells = summaryRow.querySelectorAll('td');
    for (let d = 1; d <= daysInMonth; d++) {
      const td = cells[d];
      if (!td) continue;
      const req = shiftGridRequirements[period]?.[getShiftDayType(d)] ?? null;
      if (req === null) { td.innerHTML = '<span style="color:#d1d5db;font-size:10px">—</span>'; continue; }
      const covered = deptStaff.filter(s => { if (s.skill_level === 'no_count' || s.no_count === true) return false; const shift = shiftData[`${s.id}|${d}`]; return shift && SHIFT_COVERS[shift]?.includes(period); }).length;
      const ok = covered >= req;
      const bg = req===0?'#f3f4f6':ok?'#d1fae5':'#fee2e2';
      const color = req===0?'#9ca3af':ok?'#065f46':'#be123c';
      td.innerHTML = `<div style="background:${bg};color:${color};font-size:10px;font-weight:700;border-radius:4px;padding:2px 0;text-align:center">${req===0?'0':`${covered}/${req}`}</div>`;
    }
  });
}

// 元に戻す／やり直し（キーボード Ctrl+Z / Ctrl+Y と、ツールバーの 戻る/進む ボタンで共用）
function doUndo() {
  if (!checkConfirmLock()) return;
  if (undoStack.length === 0) { showToast('これ以上戻れません'); return; }
  redoStack.push({
    shiftData: JSON.parse(JSON.stringify(shiftData)),
    lockedCells: JSON.parse(JSON.stringify(lockedCells))
  });
  const prev = undoStack.pop();
  shiftData = prev.shiftData;
  lockedCells = prev.lockedCells;
  rerenderShiftGridFromMemory();
  showToast('元に戻しました');
}
function doRedo() {
  if (!checkConfirmLock()) return;
  if (redoStack.length === 0) { showToast('これ以上進めません'); return; }
  undoStack.push({
    shiftData: JSON.parse(JSON.stringify(shiftData)),
    lockedCells: JSON.parse(JSON.stringify(lockedCells))
  });
  const next = redoStack.pop();
  shiftData = next.shiftData;
  lockedCells = next.lockedCells;
  rerenderShiftGridFromMemory();
  showToast('やり直しました');
}

document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  const activePage = document.querySelector('.page.active')?.id;
  if (activePage !== 'page-shift') return;
  if (selectedCells.size === 0 && !['z','y'].includes(e.key?.toLowerCase())) return;

  // ★ 確定ロック中は破壊的操作（cut/paste/delete/undo/redo）をブロック
  //   コピー（Ctrl+C）と通常入力はそのまま通す
  const isDestructive =
    (ctrl && (e.key === 'x' || e.key === 'v' || e.key?.toLowerCase() === 'z' || e.key?.toLowerCase() === 'y')) ||
    e.key === 'Delete' || e.key === 'Backspace';
  if (isDestructive && !checkConfirmLock()) {
    e.preventDefault();
    return;
  }

  if (ctrl && e.key === 'c') {
    e.preventDefault();
    clipboard = { type:'copy', data:{} };
    selectedCells.forEach(key => { clipboard.data[key] = shiftData[key] || null; });
    showToast(`${selectedCells.size}セルをコピーしました`);
    return;
  }
  if (ctrl && e.key === 'x') {
    e.preventDefault();
    clipboard = { type:'cut', data:{} };
    selectedCells.forEach(key => { clipboard.data[key] = shiftData[key] || null; });
    saveUndoState();
    selectedCells.forEach(key => {
      if (!lockedCells[key]) {
        delete shiftData[key];
        const [sid,d] = parseKey(key);
        const el = getCellEl(sid,d);
        if (el) { el.className='shift-cell empty'; const sp=el.querySelector('span:first-child'); if(sp&&sp.tagName==='SPAN')sp.textContent='+'; else if(el.childNodes[0]&&el.childNodes[0].nodeType===3)el.childNodes[0].textContent='+'; }
      }
    });
    refreshSummaryRows();
    showToast(`${selectedCells.size}セルを切り取りました`);
    return;
  }
  if (ctrl && e.key === 'v') {
    e.preventDefault();
    if (!clipboard || selectedCells.size === 0) return;
    saveUndoState();
    const srcKeys = Object.keys(clipboard.data);
    if (srcKeys.length === 0) return;
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });
    const staffIds = deptStaff.map(s => s.id);
    const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
    if (srcKeys.length === 1) {
      const shiftId = Object.values(clipboard.data)[0];
      const targets = selectedCells.size > 0 ? selectedCells : new Set(srcKeys);
      targets.forEach(key => {
        if (lockedCells[key]) return;
        if (shiftId) shiftData[key] = shiftId; else delete shiftData[key];
        const [sid,d] = parseKey(key);
        const el = getCellEl(sid,d);
        if (el) {
          el.className=`shift-cell ${SHIFT_COLORS[shiftId]||'empty'}`;
          el.style.flexDirection='column';
          el.style.minHeight='34px';
          const sp=el.querySelector('span:first-child');
          if(sp&&sp.tagName==='SPAN')sp.textContent=shiftId||'+';
          else if(el.childNodes[0]&&el.childNodes[0].nodeType===3)el.childNodes[0].textContent=shiftId||'+';
        }
      });
    } else {
      const srcArr = srcKeys.map(k => { const [sid,d]=k.split('-'); return {si:staffIds.indexOf(sid),d:parseInt(d)}; });
      const minSi = Math.min(...srcArr.map(x=>x.si));
      const minD = Math.min(...srcArr.map(x=>x.d));
      const [tgtSid,tgtD] = [...selectedCells][0].split('-');
      const tgtSi = staffIds.indexOf(tgtSid);
      srcKeys.forEach(srcKey => {
        const [sid,d] = srcKey.split('-');
        const si = staffIds.indexOf(sid);
        const newSi = tgtSi+(si-minSi);
        const newD = parseInt(tgtD)+(parseInt(d)-minD);
        if (newSi<0||newSi>=staffIds.length||newD<1||newD>daysInMonth) return;
        const newKey = `${staffIds[newSi]}-${newD}`;
        if (lockedCells[newKey]) return;
        const shiftId = clipboard.data[srcKey];
        if (shiftId) shiftData[newKey]=shiftId; else delete shiftData[newKey];
        const el = getCellEl(staffIds[newSi],newD);
        if (el) { el.className=`shift-cell ${SHIFT_COLORS[shiftId]||'empty'}`; const t=el.childNodes[0]; if(t&&t.nodeType===3)t.textContent=shiftId||'+'; }
      });
    }
    if (clipboard.type==='cut') clipboard=null;
    refreshSummaryRows();
    showToast('貼り付けました ✓','success');
    return;
  }
  if ((e.key==='Delete'||e.key==='Backspace') && selectedCells.size>0) {
    if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
    e.preventDefault();
    const updatedStaffIds = new Set([...selectedCells].map(k => parseKey(k)[0]));
    const deletedCount = selectedCells.size;
    applyShiftToSelected(null);
    updatedStaffIds.forEach(sid => refreshHoursCell(sid));
    // ★ 削除後は選択状態をクリアする。
    //   クリアしないと、次に 1 セルをクリックした時に
    //  「複数選択中の選択済みセル」と判定されてモーダルが複数適用モードで開き、
    //   1 セル変更のつもりが選択範囲全体に適用される事故が起きる。
    selectedCells.clear();
    lastSelectedCell = null;
    highlightSelected();
    showToast(`${deletedCount}セルを削除しました`);
    return;
  }
  if (ctrl && e.key==='z' && !e.shiftKey) {
    e.preventDefault();
    doUndo();
    return;
  }
  if ((ctrl&&e.key==='y')||(ctrl&&e.shiftKey&&e.key==='z')) {
    e.preventDefault();
    doRedo();
    return;
  }
  if (ctrl&&e.key==='a') {
    e.preventDefault();
    const deptStaff = allStaff.filter(s=>s.dept_id===currentDept);
    const daysInMonth = new Date(shiftYear,shiftMonth,0).getDate();
    selectedCells.clear();
    deptStaff.forEach(s => { for(let d=1;d<=daysInMonth;d++) selectedCells.add(`${s.id}|${d}`); });
    highlightSelected();
    showToast(`全${selectedCells.size}セルを選択`);
    return;
  }
  if (e.key==='Escape') {
    selectedCells.clear();
    highlightSelected();
    return;
  }
});


// ===== シフト確定 =====
document.getElementById('confirmShiftBtn')?.addEventListener('click', async () => {
  const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
  const count = Object.keys(shiftData).length;

  if (count === 0) {
    showToast('確定するシフトがありません', 'error');
    return;
  }

  const confirmed = window.confirm(
    `${DEPT_NAMES[currentDept]} ${shiftYear}年${shiftMonth}月のシフトを確定しますか？\n\n確定するとスタッフのアプリに表示されます。\n確定後も変更・再確定が可能です。`
  );
  if (!confirmed) return;

  showLoading();
  try {
    // まず保存
    const deptStaff2 = allStaff.filter(s => s.dept_id === currentDept);
    const ids = deptStaff2.map(s => `"${s.id}"`).join(',');

    if (ids) {
      await sb(`shifts?staff_id=in.(${ids})&year=eq.${shiftYear}&month=eq.${shiftMonth}`, { method:'DELETE' });
    }

    const inserts = Object.entries(shiftData).map(([key, shiftId]) => {
      const [staffId, day] = parseKey(key);
      return {
        staff_id: staffId,
        year: shiftYear,
        month: shiftMonth,
        day: parseInt(day),
        shift_type_id: shiftId,
        is_locked: !!lockedCells[key],
        is_confirmed: true  // 確定フラグを立てる
      };
    });

    if (inserts.length > 0) {
      await sb('shifts', { method:'POST', body:JSON.stringify(inserts) });
    }

    // ★ 未選択セルのロックを永続化
    await persistCellLocks(ids, shiftYear, shiftMonth);

    // ★ 確定状態を更新してバナー表示も自動切替
    isCurrentMonthConfirmed = true;
    updateConfirmLockUI();

    showToast(`${shiftMonth}月のシフトを確定しました ✓ スタッフに公開されました`, 'success');
  } catch(e) {
    console.error(e);
    showToast('確定エラー', 'error');
  }
  hideLoading();
});

// 未選択セルのロック永続化ヘルパー
// shifts.is_locked はシフト選択済みセル用、cell_locks は未選択セル用に役割分担。
// 呼び出し側で shifts の保存（DELETE→INSERT）を済ませた後に呼ぶ。
// テーブル未作成時は警告のみで処理継続（既存機能を壊さない）。
async function persistCellLocks(staffIdsCsv, year, month) {
  if (!staffIdsCsv) return;
  try {
    await sb(`cell_locks?staff_id=in.(${staffIdsCsv})&year=eq.${year}&month=eq.${month}`, { method:'DELETE' });
    // シフト未選択かつロック有りのセルのみを cell_locks に保存
    const inserts = Object.keys(lockedCells)
      .filter(key => !shiftData[key])
      .map(key => {
        const [staffId, day] = parseKey(key);
        return { staff_id: staffId, year, month, day: parseInt(day) };
      });
    if (inserts.length > 0) {
      await sb('cell_locks', { method:'POST', body:JSON.stringify(inserts) });
    }
  } catch(e) {
    console.warn('cell_locks 保存スキップ（テーブル未作成の可能性）:', e);
  }
}

// シフト保存
document.getElementById('saveShiftBtn').addEventListener('click', async () => {
  // ★ 確定ロック中は保存ブロック
  if (!checkConfirmLock()) return;
  showLoading();
  try {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });
    const ids = deptStaff.map(s => `"${s.id}"`).join(',');
    if (ids) {
      await sb(`shifts?staff_id=in.(${ids})&year=eq.${shiftYear}&month=eq.${shiftMonth}`, { method:'DELETE' });
    }
    const inserts = Object.entries(shiftData).map(([key, shiftId]) => {
      const [staffId, day] = parseKey(key);
      return { staff_id:staffId, year:shiftYear, month:shiftMonth, day:parseInt(day), shift_type_id:shiftId, is_locked:!!lockedCells[key] };
    });
    if (inserts.length > 0) {
      await sb('shifts', { method:'POST', body:JSON.stringify(inserts) });
    }
    // ★ 未選択セルのロックを永続化
    await persistCellLocks(ids, shiftYear, shiftMonth);
    // 保存時点スナップショット更新（保存時点に戻すボタン用）
    savedShiftSnapshot = {
      shiftData: JSON.parse(JSON.stringify(shiftData)),
      lockedCells: JSON.parse(JSON.stringify(lockedCells))
    };
    undoStack = [];
    redoStack = [];
    showToast('シフトを保存しました ✓','success');
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
});

// 保存時点に戻すボタン
document.getElementById('undoBtn')?.addEventListener('click', doUndo);
document.getElementById('redoBtn')?.addEventListener('click', doRedo);

// ===== SETTINGS =====


// ===== アカウント管理 =====
async function loadAccountPage() {
  // マスター権限チェック（直接URL等での不正アクセス防止）
  if (!adminUser || adminUser.role !== 'master') {
    document.getElementById('page-account').innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626"><div style="font-size:32px;margin-bottom:12px">🔒</div><div style="font-size:14px;font-weight:600">アクセス権限がありません</div><div style="font-size:12px;color:#6b7280;margin-top:8px">アカウント管理は管理権限が必要です</div></div>';
    return;
  }
  // パスワード変更はすべてのロールで可能
  document.getElementById('changePwBtn').onclick = changePassword;

  // マスターのみアカウント一覧を表示
  if (adminUser.role === 'master') {
    document.getElementById('accountListCard').style.display = 'block';
    await loadAccountList();
  }
}

async function changePassword() {
  const currentPw = document.getElementById('currentPw').value;
  const newPw = document.getElementById('newPw').value;
  const newPwConfirm = document.getElementById('newPwConfirm').value;

  if (!currentPw || !newPw || !newPwConfirm) {
    showToast('すべて入力してください', 'error'); return;
  }
  if (newPw.length < 4) {
    showToast('新しいパスワードは4文字以上にしてください', 'error'); return;
  }
  if (newPw !== newPwConfirm) {
    showToast('新しいパスワードが一致しません', 'error'); return;
  }

  showLoading();
  try {
    await adminApi('/api/auth', {
      action: 'change-password',
      currentPassword: currentPw,
      newPassword: newPw,
    });
    document.getElementById('currentPw').value = '';
    document.getElementById('newPw').value = '';
    document.getElementById('newPwConfirm').value = '';
    showToast('パスワードを変更しました ✓', 'success');
  } catch(e) {
    console.error(e);
    showToast(e.message || '変更エラー', 'error');
  }
  hideLoading();
}

async function loadAccountList() {
  showLoading();
  try {
    const data = await adminApi('/api/admin-accounts', { action: 'list' });
    const accounts = data.accounts || [];
    const ROLE_LABELS = { master:'管理', leader:'リーダー', staff:'スタッフ' };
    document.getElementById('accountBody').innerHTML = accounts.map(a => {
      const isLocked = !!a.locked_at;
      const fails = a.failed_attempts || 0;
      let statusHtml = '';
      if (isLocked) {
        statusHtml = '<span style="color:#dc2626;font-weight:600">🔒 ロック中</span>';
      } else if (fails > 0) {
        statusHtml = `<span style="color:#f59e0b">⚠️ 失敗${fails}回</span>`;
      } else {
        statusHtml = '<span style="color:#10b981">正常</span>';
      }
      const unlockBtn = isLocked
        ? `<button class="btn btn-outline btn-sm" style="color:#10b981;border-color:#10b981" onclick="unlockAccount('${a.id}','${a.name}')">解除</button>`
        : '';
      return `
      <tr>
        <td>${a.name}${a.role==='staff' ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">スタッフID: ${a.staff_code != null ? a.staff_code : '<span style="color:#dc2626">未設定</span>'}</div>` : ''}</td>
        <td><span class="badge ${a.role==='master'?'badge-master':a.role==='leader'?'badge-leader':'badge-part'}">${ROLE_LABELS[a.role]||a.role}</span></td>
        <td>${a.dept_id !== null ? DEPT_NAMES[a.dept_id] : '全部門'}</td>
        <td>${statusHtml}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          ${unlockBtn}
          <button class="btn btn-outline btn-sm" onclick="showEditAccountModal('${a.id}','${a.name}','${a.role}',${a.dept_id},${a.staff_code != null ? a.staff_code : 'null'},'${a.staff_id || ''}')">編集</button>
          ${a.id !== adminUser.id ? `<button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteAccount('${a.id}','${a.name}')">削除</button>` : ''}
        </td>
      </tr>`;
    }).join('');
  } catch(e) { console.error(e); }
  hideLoading();
}

async function unlockAccount(id, name) {
  if (!confirm(`${name}のアカウントロックを解除しますか？`)) return;
  showLoading();
  try {
    await adminApi('/api/admin-accounts', { action: 'unlock', id });
    await loadAccountList();
    showToast(`${name}のロックを解除しました ✓`, 'success');
  } catch(e) {
    console.error(e);
    showToast('解除エラー：' + (e.message || ''), 'error');
  }
  hideLoading();
}

function showAddAccountModal() {
  document.getElementById('addAccountModalEl')?.remove();
  const modal = document.createElement('div');
  modal.id = 'addAccountModalEl';
  modal.className = 'modal-overlay show';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-title">アカウント追加</div>
      <div class="form-group"><label class="form-label">名前（苗字）</label><input type="text" class="form-input" id="newAccName" placeholder="山田"></div>
      <div class="form-group"><label class="form-label">初期パスワード</label><input type="password" class="form-input" id="newAccPw" placeholder="4文字以上"></div>
      <div class="form-group"><label class="form-label">権限</label>
        <select class="form-select" id="newAccRole" onchange="document.getElementById('newAccDeptGroup').style.display=this.value==='leader'||this.value==='staff'?'block':'none'">
          <option value="leader">リーダー</option>
          <option value="staff">スタッフ</option>
          <option value="master">管理</option>
        </select>
      </div>
      <div class="form-group" id="newAccDeptGroup">
        <label class="form-label">部門</label>
        <select class="form-select" id="newAccDept">
          <option value="0">医療事務</option><option value="1">看護</option>
          <option value="2">リハビリ</option><option value="3">放射線</option>
        </select>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="document.getElementById('addAccountModalEl').remove()">キャンセル</button>
        <button class="btn btn-primary" onclick="addAccount()">追加する</button>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function addAccount() {
  const name = document.getElementById('newAccName').value.trim();
  const pw = document.getElementById('newAccPw').value;
  const role = document.getElementById('newAccRole').value;
  const deptId = ['leader','staff'].includes(role) ? parseInt(document.getElementById('newAccDept').value) : null;

  if (!name || !pw) { showToast('すべて入力してください', 'error'); return; }
  if (pw.length < 4) { showToast('パスワードは4文字以上にしてください', 'error'); return; }

  showLoading();
  try {
    await adminApi('/api/admin-accounts', {
      action: 'create',
      name, password: pw, role, deptId,
    });
    document.getElementById('addAccountModalEl')?.remove();
    await loadAccountList();
    showToast(`${name}のアカウントを追加しました ✓`, 'success');
  } catch(e) {
    console.error(e);
    showToast(e.message || '追加エラー', 'error');
  }
  hideLoading();
}

// アカウント紐付け用：指定部門のスタッフを<option>化（value=staff.id, data-code=現staff_code）
function accountStaffOptions(deptId, selectedStaffId) {
  const d = Number(deptId);
  const list = (typeof allStaff !== 'undefined' ? allStaff : []).filter(s => s.dept_id === d);
  const opts = ['<option value="">（紐付けなし）</option>'];
  list.forEach(s => {
    const sel = (selectedStaffId && s.id === selectedStaffId) ? 'selected' : '';
    opts.push(`<option value="${s.id}" data-code="${s.staff_code ?? ''}" ${sel}>${escapeHtml(s.name)}（現ID:${s.staff_code ?? '—'}）</option>`);
  });
  return opts.join('');
}

function showEditAccountModal(id, name, role, deptId, staffCode, staffId) {
  document.getElementById('editAccountModalEl')?.remove();
  const modal = document.createElement('div');
  modal.id = 'editAccountModalEl';
  modal.className = 'modal-overlay show';
  const isSelf = id === adminUser.id;
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-title">${name}のアカウント編集</div>
      <div class="form-group"><label class="form-label">名前（苗字）</label><input type="text" class="form-input" id="editAccName" value="${name}"></div>
      <div class="form-group"><label class="form-label">権限${isSelf ? '（自分自身の権限は変更できません）' : ''}</label>
        <select class="form-select" id="editAccRole" ${isSelf ? 'disabled' : ''} onchange="document.getElementById('editAccDeptGroup').style.display=this.value==='master'?'none':'block';document.getElementById('editAccStaffLinkGroup').style.display=this.value==='staff'?'block':'none';document.getElementById('editAccStaffSelect').innerHTML=accountStaffOptions(document.getElementById('editAccDept').value,'')">
          <option value="master" ${role==='master'?'selected':''}>管理</option>
          <option value="leader" ${role==='leader'?'selected':''}>リーダー</option>
          <option value="staff" ${role==='staff'?'selected':''}>スタッフ</option>
        </select>
      </div>
      <div class="form-group" id="editAccDeptGroup" style="display:${role==='master'?'none':'block'}">
        <label class="form-label">部門</label>
        <select class="form-select" id="editAccDept" ${isSelf ? 'disabled' : ''} onchange="document.getElementById('editAccStaffSelect').innerHTML=accountStaffOptions(this.value,'')">
          <option value="0" ${deptId===0?'selected':''}>医療事務</option>
          <option value="1" ${deptId===1?'selected':''}>看護</option>
          <option value="2" ${deptId===2?'selected':''}>リハビリ</option>
          <option value="3" ${deptId===3?'selected':''}>放射線</option>
        </select>
      </div>
      <div class="form-group" id="editAccStaffLinkGroup" style="display:${role==='staff'?'block':'none'}">
        <label class="form-label">紐付けスタッフ</label>
        <select class="form-select" id="editAccStaffSelect" onchange="var o=this.options[this.selectedIndex];document.getElementById('editAccStaffCode').value=o.getAttribute('data-code')||''">${accountStaffOptions(deptId, staffId || '')}</select>
        <label class="form-label" style="margin-top:8px">スタッフID（4〜5桁・ログイン用）</label>
        <input type="text" inputmode="numeric" class="form-input" id="editAccStaffCode" value="${staffCode ?? ''}" placeholder="例: 1042">
        <div style="font-size:11px;color:#6b7280;margin-top:4px">スタッフを選んでIDを設定すると、シフト表側の該当スタッフ（氏名・ID）に紐付き、その番号＋部門＋パスワードでログインできます。</div>
      </div>
      <div class="form-group"><label class="form-label">新しいパスワード（変更する場合のみ）</label><input type="password" class="form-input" id="editAccPw" placeholder="空欄で変更なし"></div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="document.getElementById('editAccountModalEl').remove()">キャンセル</button>
        <button class="btn btn-primary" onclick="updateAccount('${id}')">保存する</button>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function updateAccount(id) {
  const name = document.getElementById('editAccName').value.trim();
  const pw = document.getElementById('editAccPw').value;
  const isSelf = id === adminUser.id;
  const role = isSelf ? null : document.getElementById('editAccRole').value;
  const deptId = isSelf ? null : (role === 'master' ? null : parseInt(document.getElementById('editAccDept').value));

  if (!name) { showToast('名前は必須です', 'error'); return; }
  if (pw && pw.length < 4) { showToast('パスワードは4文字以上にしてください', 'error'); return; }

  // スタッフ紐付け（role=staff のときのみ）
  const staffLinkActive = !isSelf && role === 'staff';
  let staffId = '', staffCode = '';
  if (staffLinkActive) {
    staffId = document.getElementById('editAccStaffSelect').value || '';
    const codeRaw = (document.getElementById('editAccStaffCode').value || '').trim();
    if (staffId) {
      if (!/^\d{1,5}$/.test(codeRaw)) { showToast('スタッフIDは数字（最大5桁）で入力してください', 'error'); return; }
      staffCode = parseInt(codeRaw);
      // 同部門内 staff_code 重複チェック（選択スタッフ自身は除外）
      const dup = allStaff.find(s => s.dept_id === deptId && s.staff_code === staffCode && s.id !== staffId);
      if (dup) { showToast(`スタッフID ${staffCode} は同部門の「${dup.name}」が使用中です`, 'error'); return; }
    } else {
      // 紐付けなしを選択 → 解除（空で送信）
      staffCode = '';
    }
  }

  showLoading();
  try {
    const payload = { action: 'update', id, name };
    if (pw) payload.password = pw;
    if (!isSelf) {
      payload.role = role;
      payload.deptId = deptId;
    }
    if (staffLinkActive) {
      payload.staffId = staffId;     // uuid or '' (解除)
      payload.staffCode = staffCode; // 数値 or '' (解除)
    }
    await adminApi('/api/admin-accounts', payload);

    // 紐付け先 staff も同期：staff_code を合わせ、表示氏名もアカウント名に合わせる（uuidで確実に特定）
    if (staffLinkActive && staffId) {
      await sb(`staff?id=eq.${staffId}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ staff_code: staffCode, name })
      });
      const idx = allStaff.findIndex(s => s.id === staffId);
      if (idx !== -1) { allStaff[idx].staff_code = staffCode; allStaff[idx].name = name; }
    }

    document.getElementById('editAccountModalEl')?.remove();
    await loadAccountList();
    showToast(
      (staffLinkActive && staffId) ? 'アカウントを更新し、スタッフと紐付けました ✓' : 'アカウントを更新しました ✓',
      'success'
    );
  } catch(e) {
    console.error(e);
    showToast('更新エラー：' + (e.message || ''), 'error');
  }
  hideLoading();
}

async function deleteAccount(id, name) {
  if (!confirm(`${name}のアカウントを削除しますか？`)) return;
  showLoading();
  try {
    await adminApi('/api/admin-accounts', { action: 'delete', id });
    await loadAccountList();
    showToast(`${name}のアカウントを削除しました`, 'success');
  } catch(e) { showToast('削除エラー', 'error'); }
  hideLoading();
}

// ===== 祝日・特殊日管理 =====
let specialYear = new Date().getFullYear();
let specialMonth = new Date().getMonth() + 1;
let holidayData = {}; // {day: 'open'|'closed'} 祝日の診療状況
let thursdayData = {}; // {day: true|false} 木曜の診療状況
let customClosedData = {}; // {day: 'お盆休み'} 任意休診日のラベル

// 日本の祝日（2026年）
const JAPAN_HOLIDAYS_2026 = {
  '2026-1': [1],
  '2026-2': [11,23],
  '2026-3': [20],
  '2026-4': [29],
  '2026-5': [3,4,5,6],
  '2026-7': [20],
  '2026-8': [11],
  '2026-9': [21,22],
  '2026-10': [12],
  '2026-11': [3,23],
  '2026-12': [],
};

// 2027年も対応
const JAPAN_HOLIDAYS_2027 = {
  '2027-1': [1],
  '2027-2': [11,23],
  '2027-3': [20],
  '2027-4': [29],
  '2027-5': [3,4,5,6],
  '2027-7': [19],
  '2027-8': [11],
  '2027-9': [20,23],
  '2027-10': [11],
  '2027-11': [3,23],
  '2027-12': [],
};

function getDefaultHolidays(year, month) {
  const key = `${year}-${month}`;
  if (year === 2026) return new Set(JAPAN_HOLIDAYS_2026[key] || []);
  if (year === 2027) return new Set(JAPAN_HOLIDAYS_2027[key] || []);
  return new Set();
}

// ===== 水曜種別（全部署共通・月単位）=====
// wednesday_types は dept_id を持たず、年月日のみでキーされる全クリニック共通設定。
// 生成ロジック・シフト描画・設定タブの3者がこのローダーを共有する。
async function loadWedTypesMap(year, month) {
  try {
    const data = await sb(`wednesday_types?year=eq.${year}&month=eq.${month}&select=day,wed_type`);
    const map = {};
    data.forEach(w => { map[w.day] = w.wed_type; });
    return map;
  } catch(e) { console.error('[loadWedTypesMap]', e); return {}; }
}

// 設定タブ用の水曜種別の状態（specialYear/specialMonth に追従）
let settingsWedTypes = {};

function renderSettingsWedGrid(daysInMonth) {
  const el = document.getElementById('wedGrid');
  if (!el) return;

  const wedDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(specialYear, specialMonth-1, d).getDay();
    if (dow === 3) wedDays.push(d);
  }

  const types = [
    { key: 'normal', label: '通常', activeColor: 'var(--primary)', activeBg: 'var(--primary)', activeText: 'white' },
    { key: 'cc',     label: 'CC',   activeColor: '#d97706',        activeBg: '#fef3c7',        activeText: '#92400e' },
    { key: 'cho',    label: 'CHO',  activeColor: '#7c3aed',        activeBg: '#ede9fe',        activeText: '#5b21b6' },
  ];

  el.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">各水曜日の種別を選択してください（クリックで即保存・全部署共通）。</div>
    ${wedDays.map(d => {
      const cur = settingsWedTypes[d] || 'normal';
      const btns = types.map(t => {
        const active = cur === t.key;
        return `<button onclick="setWednesdayType(${d},'${t.key}')"
          style="padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;
          border:1.5px solid ${active?t.activeColor:'var(--border)'};
          background:${active?t.activeBg:'white'};
          color:${active?t.activeText:'var(--text-muted)'}">
          ${t.label}</button>`;
      }).join('');
      return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="min-width:120px;font-size:14px;font-weight:600">${specialMonth}/${d}（水）</div>
        <div style="display:flex;gap:8px">${btns}</div>
      </div>`;
    }).join('')}
  `;
}

// 水曜種別を1日分だけ即保存（木曜の setThursdayStatus と同じ方式・全部署共通）
async function setWednesdayType(day, type) {
  showLoading();
  try {
    await sb(`wednesday_types?year=eq.${specialYear}&month=eq.${specialMonth}&day=eq.${day}`, {method:'DELETE'});
    await sb('wednesday_types', {method:'POST', body:JSON.stringify([{
      year: specialYear, month: specialMonth, day, wed_type: type
    }])});
    settingsWedTypes[day] = type;
    // 水曜種別はシフト描画にも影響するためキャッシュ無効化
    if (typeof invalidateShiftCache === 'function') invalidateShiftCache();
    renderSettingsWedGrid(new Date(specialYear, specialMonth, 0).getDate());
    const labels = {normal:'通常', cc:'CC', cho:'CHO'};
    showToast(`${specialMonth}/${day}（水）を${labels[type]}に設定しました ✓`, 'success');
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
}

async function loadSpecialDays() {
  try {
    const [special, thursdays, wedMap] = await Promise.all([
      sb(`special_days?year=eq.${specialYear}&month=eq.${specialMonth}&select=day,is_holiday,is_closed,label`),
      sb(`thursday_types?year=eq.${specialYear}&month=eq.${specialMonth}&select=day,is_open`),
      loadWedTypesMap(specialYear, specialMonth)
    ]);
    settingsWedTypes = wedMap || {};
    holidayData = {};
    customClosedData = {};
    const defaultHolidays = getDefaultHolidays(specialYear, specialMonth);
    special.forEach(h => {
      // 祝日（カレンダー上の祝日）: holidayDataで管理
      // 任意休診日（祝日でない日でis_closed=true）: customClosedDataで管理
      if (defaultHolidays.has(h.day) || h.is_holiday === true) {
        holidayData[h.day] = h.is_closed ? 'closed' : 'open';
      } else if (h.is_closed === true) {
        customClosedData[h.day] = h.label || '休診';
      }
    });
    thursdayData = {};
    thursdays.forEach(t => { thursdayData[t.day] = t.is_open; });
  } catch(e) { console.error(e); }
}

async function renderSpecialDaysGrid() {
  await loadSpecialDays();
  const daysInMonth = new Date(specialYear, specialMonth, 0).getDate();
  const defaultHolidays = getDefaultHolidays(specialYear, specialMonth);
  const DOW_JP = ['日','月','火','水','木','金','土'];
  const el = document.getElementById('specialDaysGrid');
  if (!el) return;

  // 祝日一覧
  const holidayDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (defaultHolidays.has(d)) holidayDays.push(d);
    // カスタム祝日（special_daysにis_holiday=trueで登録）
  }

  if (holidayDays.length === 0) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">この月に祝日はありません</div>';
  } else {
    el.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">祝日はデフォルトで診療日扱い（土日と同じ必要人数）。休診に変更できます。</div>
      ${holidayDays.map(d => {
        const dow = new Date(specialYear, specialMonth-1, d).getDay();
        const status = holidayData[d] || 'open';
        return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="min-width:120px;font-size:14px;font-weight:600;color:#ef4444">
            ${specialMonth}/${d}（${DOW_JP[dow]}・祝）
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="setHolidayStatus(${d},'open')"
              style="padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;
              border:1.5px solid ${status==='open'?'var(--primary)':'var(--border)'};
              background:${status==='open'?'var(--primary)':'white'};
              color:${status==='open'?'white':'var(--text-muted)'}">
              診療日
            </button>
            <button onclick="setHolidayStatus(${d},'closed')"
              style="padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;
              border:1.5px solid ${status==='closed'?'var(--danger)':'var(--border)'};
              background:${status==='closed'?'#fef2f2':'white'};
              color:${status==='closed'?'var(--danger)':'var(--text-muted)'}">
              休診
            </button>
          </div>
          <div style="font-size:12px;color:var(--text-muted)">
            ${status==='open'?'土日と同じ必要人数':'必要人数なし（スタッフは休み）'}
          </div>
        </div>`;
      }).join('')}
    `;
  }

  // 木曜グリッド
  renderThursdayGrid(daysInMonth);
  // 任意休診日セクション
  renderCustomClosedSection(daysInMonth);
  // 水曜種別グリッド（全部署共通・同じ月コンテキスト）
  renderSettingsWedGrid(daysInMonth);
}

// 任意休診日：DOW略称
const _CUSTOM_CLOSED_DOW = ['日','月','火','水','木','金','土'];

function renderCustomClosedSection(daysInMonth) {
  const selectEl = document.getElementById('customClosedDaySelect');
  const listEl = document.getElementById('customClosedList');
  if (!selectEl || !listEl) return;

  // 既に祝日として登録されている日 or 任意休診日として登録されている日は除外
  const defaultHolidays = getDefaultHolidays(specialYear, specialMonth);
  const alreadyClosedDays = new Set();
  Object.entries(holidayData).forEach(([d, st]) => {
    if (st === 'closed') alreadyClosedDays.add(Number(d));
  });
  Object.keys(customClosedData).forEach(d => alreadyClosedDays.add(Number(d)));

  // セレクトボックス：休診として追加可能な日のみリスト
  let options = '<option value="">日付を選択</option>';
  for (let d = 1; d <= daysInMonth; d++) {
    if (defaultHolidays.has(d)) continue; // 祝日は上のセクションで管理
    if (alreadyClosedDays.has(d)) continue; // 既に休診の日は除外
    const dow = new Date(specialYear, specialMonth-1, d).getDay();
    options += `<option value="${d}">${specialMonth}/${d}（${_CUSTOM_CLOSED_DOW[dow]}）</option>`;
  }
  selectEl.innerHTML = options;

  // 登録済み任意休診日リスト
  const closedDays = Object.keys(customClosedData).map(Number).sort((a,b)=>a-b);
  if (closedDays.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">任意休診日はまだ登録されていません</div>';
  } else {
    listEl.innerHTML = closedDays.map(d => {
      const dow = new Date(specialYear, specialMonth-1, d).getDay();
      const label = customClosedData[d] || '休診';
      return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="min-width:120px;font-size:14px;font-weight:600;color:#6b7280">
            ${specialMonth}/${d}（${_CUSTOM_CLOSED_DOW[dow]}）
          </div>
          <div style="flex:1;font-size:13px;color:#1f2937">${escapeHtml(label)}</div>
          <button onclick="removeCustomClosedDay(${d})"
            style="padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid var(--danger);background:white;color:var(--danger);font-family:inherit">
            削除
          </button>
        </div>`;
    }).join('');
  }
}

async function addCustomClosedDay() {
  const selectEl = document.getElementById('customClosedDaySelect');
  const labelEl = document.getElementById('customClosedLabelInput');
  const day = Number(selectEl.value);
  const label = (labelEl.value || '').trim() || '休診';
  if (!day) {
    showToast('日付を選択してください', 'error');
    return;
  }
  showLoading();
  try {
    // 既存のレコードがあれば削除してから挿入（UPSERT相当）
    await sb(`special_days?year=eq.${specialYear}&month=eq.${specialMonth}&day=eq.${day}`, {method:'DELETE'});
    await sb('special_days', {method:'POST', body:JSON.stringify([{
      year: specialYear, month: specialMonth, day,
      day_type: 'clinic_closed',
      is_holiday: false,
      is_closed: true,
      label: label
    }])});
    customClosedData[day] = label;
    labelEl.value = '';
    await renderSpecialDaysGrid();
    showToast(`${specialMonth}/${day}を休診日に設定しました ✓`, 'success');
  } catch(e) {
    console.error(e);
    showToast('保存エラー', 'error');
  }
  hideLoading();
}

async function removeCustomClosedDay(day) {
  if (!confirm(`${specialMonth}/${day}の休診日設定を解除しますか？`)) return;
  showLoading();
  try {
    await sb(`special_days?year=eq.${specialYear}&month=eq.${specialMonth}&day=eq.${day}`, {method:'DELETE'});
    delete customClosedData[day];
    await renderSpecialDaysGrid();
    showToast(`${specialMonth}/${day}の休診を解除しました ✓`, 'success');
  } catch(e) {
    console.error(e);
    showToast('削除エラー', 'error');
  }
  hideLoading();
}

function renderThursdayGrid(daysInMonth) {
  const DOW_JP = ['日','月','火','水','木','金','土'];
  const el = document.getElementById('thursdayGrid');
  if (!el) return;

  const thursDays = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(specialYear, specialMonth-1, d).getDay();
    if (dow === 4) thursDays.push(d);
  }

  el.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">木曜はデフォルトで休診。診療日に変更すると土日と同じ必要人数が適用されます。</div>
    ${thursDays.map(d => {
      const isOpen = thursdayData[d] === true;
      return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="min-width:120px;font-size:14px;font-weight:600">
          ${specialMonth}/${d}（木）
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="setThursdayStatus(${d},false)"
            style="padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;
            border:1.5px solid ${!isOpen?'var(--danger)':'var(--border)'};
            background:${!isOpen?'#fef2f2':'white'};
            color:${!isOpen?'var(--danger)':'var(--text-muted)'}">
            休診
          </button>
          <button onclick="setThursdayStatus(${d},true)"
            style="padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;
            border:1.5px solid ${isOpen?'var(--primary)':'var(--border)'};
            background:${isOpen?'var(--primary)':'white'};
            color:${isOpen?'white':'var(--text-muted)'}">
            診療日
          </button>
        </div>
        <div style="font-size:12px;color:var(--text-muted)">
          ${isOpen?'土日と同じ必要人数':'必要人数なし'}
        </div>
      </div>`;
    }).join('')}
  `;
}

async function setHolidayStatus(day, status) {
  showLoading();
  try {
    await sb(`special_days?year=eq.${specialYear}&month=eq.${specialMonth}&day=eq.${day}`, {method:'DELETE'});
    await sb('special_days', {method:'POST', body:JSON.stringify([{
      year: specialYear, month: specialMonth, day,
      day_type: status === 'closed' ? 'holiday_closed' : 'holiday_jp',
      is_holiday: true,
      is_closed: status === 'closed',
      label: status === 'closed' ? '休診' : '診療日'
    }])});
    holidayData[day] = status;
    await renderSpecialDaysGrid();
    showToast(`${specialMonth}/${day}を${status==='closed'?'休診':'診療日'}に設定しました ✓`, 'success');
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
}

async function setThursdayStatus(day, isOpen) {
  showLoading();
  try {
    await sb(`thursday_types?year=eq.${specialYear}&month=eq.${specialMonth}&day=eq.${day}`, {method:'DELETE'});
    await sb('thursday_types', {method:'POST', body:JSON.stringify([{
      year: specialYear, month: specialMonth, day, is_open: isOpen
    }])});
    thursdayData[day] = isOpen;
    renderThursdayGrid(new Date(specialYear, specialMonth, 0).getDate());
    showToast(`${specialMonth}/${day}（木）を${isOpen?'診療日':'休診'}に設定しました ✓`, 'success');
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
}

// 月ナビ
document.getElementById('specialPrevMonth')?.addEventListener('click', async () => {
  specialMonth--; if(specialMonth<1){specialMonth=12;specialYear--;}
  document.getElementById('specialMonthTitle').textContent = `${specialYear}年${specialMonth}月`;
  await renderSpecialDaysGrid();
});
document.getElementById('specialNextMonth')?.addEventListener('click', async () => {
  specialMonth++; if(specialMonth>12){specialMonth=1;specialYear++;}
  document.getElementById('specialMonthTitle').textContent = `${specialYear}年${specialMonth}月`;
  await renderSpecialDaysGrid();
});
document.getElementById('addCustomClosedBtn')?.addEventListener('click', addCustomClosedDay);
document.getElementById('customClosedLabelInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addCustomClosedDay(); }
});


// ===== 初心者上限設定 =====
let beginnerLimitsDept = 0;
let beginnerLimitsData = {};

async function loadBeginnerLimits() {
  // 部門タブを構築
  const depts = adminUser.role === 'master' ? DEPT_IDS : [adminUser.deptId];
  const tabEl = document.getElementById('beginnerDeptTabs');
  if (tabEl) {
    tabEl.innerHTML = '';
    depts.forEach(dId => {
      const btn = document.createElement('button');
      btn.className = `dept-tab${dId === beginnerLimitsDept ? ' active' : ''}`;
      btn.textContent = DEPT_NAMES[dId];
      btn.addEventListener('click', () => {
        beginnerLimitsDept = dId;
        tabEl.querySelectorAll('.dept-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderBeginnerLimitsGrid();
      });
      tabEl.appendChild(btn);
    });
  }

  // データ取得
  try {
    const data = await sb(`beginner_limits?dept_id=eq.${beginnerLimitsDept}&select=period_id,day_type,max_beginners`);
    beginnerLimitsData = {};
    data.forEach(d => {
      const key = `${d.period_id}-${d.day_type}`;
      beginnerLimitsData[key] = d.max_beginners;
    });
  } catch(e) { console.error(e); }

  renderBeginnerLimitsGrid();
}

function renderBeginnerLimitsGrid() {
  const el = document.getElementById('beginnerLimitsGrid');
  if (!el) return;

  const periods = [{id:'morning',label:'午前帯'},{id:'afternoon',label:'午後帯'},{id:'evening',label:'夜間帯'}];
  const dayTypes = [
    {id:'weekday',label:'月火金'},
    {id:'wed_normal',label:'水(通常)'},
    {id:'wed_cc',label:'水(CC)'},
    {id:'wed_cho',label:'水(CHO)'},
    {id:'weekend',label:'土日'},
    {id:'thu_open',label:'木(診療)'},
    {id:'holiday_jp',label:'祝日'},
  ];

  let html = `<table class="req-table"><thead><tr>
    <th>時間帯</th>
    ${dayTypes.map(d => `<th>${d.label}</th>`).join('')}
  </tr></thead><tbody>`;

  periods.forEach(p => {
    html += `<tr><td style="font-weight:600;text-align:left;padding-left:10px">${p.label}</td>`;
    dayTypes.forEach(d => {
      const key = `${p.id}-${d.id}`;
      const val = beginnerLimitsData[key];
      html += `<td><input type="number" class="req-input" 
        id="beg-${p.id}-${d.id}" 
        value="${val !== undefined ? val : ''}" 
        placeholder="∞" min="0" max="20"></td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

document.getElementById('saveBeginnerLimitsBtn')?.addEventListener('click', async () => {
  showLoading();
  try {
    await sb(`beginner_limits?dept_id=eq.${beginnerLimitsDept}`, {method:'DELETE'});
    const periods = ['morning','afternoon','evening'];
    const dayTypes = ['weekday','wed_normal','wed_cc','wed_cho','weekend','thu_open','holiday_jp'];
    const inserts = [];
    periods.forEach(p => {
      dayTypes.forEach(d => {
        const el = document.getElementById(`beg-${p}-${d}`);
        if (el && el.value !== '') {
          inserts.push({dept_id:beginnerLimitsDept, period_id:p, day_type:d, max_beginners:parseInt(el.value)});
        }
      });
    });
    if (inserts.length > 0) {
      await sb('beginner_limits', {method:'POST', body:JSON.stringify(inserts)});
    }
    showToast('初心者上限を保存しました ✓','success');
    // ローカルデータも更新
    beginnerLimitsData = {};
    inserts.forEach(i => { beginnerLimitsData[`${i.period_id}-${i.day_type}`] = i.max_beginners; });
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
});

// =====================================================
// 希望シフト上限管理（フェーズ4）
// =====================================================
let reqLimitDept = 0;

async function loadReqLimits() {
  // 部門タブ生成
  const tabs = document.getElementById('reqLimitDeptTabs');
  if (tabs && !tabs.dataset.built) {
    tabs.innerHTML = '';
    // リーダーは自部署のみ。master は全部署（他機能と同じ分岐）
    const reqLimitDepts = adminUser.role === 'master'
      ? Object.entries(DEPT_NAMES)
      : [[String(adminUser.deptId), DEPT_NAMES[adminUser.deptId]]];
    reqLimitDepts.forEach(([id, name]) => {
      const btn = document.createElement('button');
      btn.className = `dept-tab${parseInt(id) === reqLimitDept ? ' active' : ''}`;
      btn.textContent = name;
      btn.dataset.dept = id;
      btn.addEventListener('click', async () => {
        reqLimitDept = parseInt(btn.dataset.dept, 10);
        tabs.querySelectorAll('.dept-tab').forEach(t => t.classList.toggle('active', parseInt(t.dataset.dept,10) === reqLimitDept));
        await fetchReqLimits();
      });
      tabs.appendChild(btn);
    });
    tabs.dataset.built = '1';
  }
  await fetchReqLimits();
}

async function fetchReqLimits() {
  try {
    // デフォルトテーブルから取得
    const data = await sb(`shift_request_limits_default?dept_id=eq.${reqLimitDept}&select=*`);
    const row = data[0] || {};
    document.getElementById('limitKibouKyu').value = row.limit_kibou_kyu ?? '';
    document.getElementById('limitYukyu').value = row.limit_yukyu ?? '';
    document.getElementById('limitOther').value = row.limit_other ?? '';
  } catch(e) {
    console.error('上限取得エラー', e);
  }
}

document.getElementById('saveReqLimitsBtn')?.addEventListener('click', async () => {
  const parseVal = (v) => {
    const t = (v || '').trim();
    if (t === '') return null;
    const n = parseInt(t, 10);
    if (isNaN(n) || n < 0 || n > 31) return 'invalid';
    return n;
  };
  const kk = parseVal(document.getElementById('limitKibouKyu').value);
  const yk = parseVal(document.getElementById('limitYukyu').value);
  const ot = parseVal(document.getElementById('limitOther').value);
  if (kk === 'invalid' || yk === 'invalid' || ot === 'invalid') {
    showToast('上限値は0〜31の整数で入力してください', 'error');
    return;
  }
  showLoading();
  try {
    // デフォルトテーブルに upsert
    const existing = await sb(`shift_request_limits_default?dept_id=eq.${reqLimitDept}&select=dept_id`);
    const payload = {
      dept_id: reqLimitDept,
      limit_kibou_kyu: kk,
      limit_yukyu: yk,
      limit_other: ot
    };
    if (existing && existing.length > 0) {
      await sb(`shift_request_limits_default?dept_id=eq.${reqLimitDept}`, {method:'PATCH', body: JSON.stringify(payload)});
    } else {
      await sb('shift_request_limits_default', {method:'POST', body: JSON.stringify([payload])});
    }
    showToast('希望シフト上限を保存しました（毎月適用されます）✓', 'success');
  } catch(e) {
    console.error(e);
    showToast('保存エラー：' + (e.message || ''), 'error');
  }
  hideLoading();
});

// =====================================================
// AI相談機能（フェーズ6）：Gemini API連携
// =====================================================
let aiAnonymizeMap = {};  // {スタッフA: '水島', スタッフB: '住元', ...}
let aiCurrentMode = '';

function buildShiftDataForAI() {
  // 現在のシフト表からAI送信用のデータを構築（匿名化）
  const dept = currentDept;
  const staffList = (allStaff || []).filter(s => s.dept_id === dept);
  const holidays = (typeof getJapaneseHolidays === 'function') ? getJapaneseHolidays(shiftYear, shiftMonth) : new Set();
  const closed = window._shiftClosedHolidays || new Set();
  const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
  const DOW_JP = ['日','月','火','水','木','金','土'];

  // スタッフを匿名化
  aiAnonymizeMap = {};
  const staffAnon = staffList.map((s, idx) => {
    let anon;
    if (idx < 26) {
      anon = `スタッフ${String.fromCharCode(65 + idx)}`;
    } else {
      const i = idx - 26;
      anon = `スタッフA${String.fromCharCode(65 + (i % 26))}`;
    }
    aiAnonymizeMap[anon] = s.name;
    return { anon, id: s.id, empType: s.emp_type, skillLevel: s.skill_level };
  });

  // シフト表をJSON化
  const shiftRows = staffAnon.map(sa => {
    const days = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const sh = shiftData[`${sa.id}|${d}`] || '';
      if (sh) days[d] = sh;
    }
    return {
      id: sa.anon,
      雇用形態: sa.empType === 'full' ? '常勤' : sa.empType === 'short' ? '時短' : 'パート',
      スキル: sa.skillLevel || '',
      シフト: days
    };
  });

  // 日付情報
  const dateInfo = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(shiftYear, shiftMonth - 1, d);
    const dow = dt.getDay();
    const isHol = holidays.has ? holidays.has(d) : false;
    const isClosed = closed.has ? closed.has(d) : false;
    dateInfo[d] = {
      曜日: DOW_JP[dow],
      祝日: isHol,
      休診: isClosed
    };
  }

  return {
    対象月: `${shiftYear}年${shiftMonth}月`,
    部門: DEPT_NAMES[dept],
    日付情報: dateInfo,
    シフト表: shiftRows
  };
}

function buildPromptForAI(mode) {
  const data = buildShiftDataForAI();
  const dataJson = JSON.stringify(data, null, 2);

  // 利用可能なシフト名一覧（正確な提案のため）
  const availableShifts = Object.keys(SHIFT_HOURS);
  // 匿名化されたスタッフID一覧
  const validStaffIds = Object.keys(aiAnonymizeMap);

  const base = `あなたは医療クリニックのシフト管理を支援するAIです。以下のシフト表を分析してください。

【⚠️ 重要：staffId はデータに登場する識別子のみ使用】
有効なstaffId: ${validStaffIds.join(', ')}
これら以外（実名や別の表記）は絶対に使わないこと。実名のように見えても、必ず上記のIDから選んでください。

【利用可能なシフト名（これ以外は使わないこと）】
${availableShifts.join(', ')}

【シフト時間の目安】
- 日勤(8.5H), 日勤+(9H), 長日(11H), 中抜け(8H)
- 午前(5H), 午後(5H), 時短(6H)
- 遅番(7.5H), 遅L(8.5H), リハ遅(8H), 夜勤(4H)
- CC, CHO, CCのみ
- 休み(0H), 有休(平日+8.5H/土日祝+9H), 半有休(+5H), 希望休(0H)

【シフト表データ】
~~~json
${dataJson}
~~~
`;

  let task = '';

  // custom モード：ユーザーの自由記入を反映
  if (mode === 'custom') {
    const rawUserText = (document.getElementById('aiFreeText')?.value || '').trim();
    if (!rawUserText) return base + '\n【依頼】\nこのシフト表を分析し、改善のヒントを日本語で簡潔に答えてください。';
    // 実名を匿名IDに変換してAIに送る
    const userText = anonymizeText(rawUserText);

    task = `
【ユーザーからの依頼】
${userText}

【返答形式】
上記の依頼に対して、可能であれば JSON形式 で具体的な修正案を提案してください。

JSON形式の場合（修正案がある場合）：
{
  "summary": "全体的な所感・回答（1-3文、日本語）",
  "suggestions": [
    {
      "staffId": "スタッフA",
      "day": 15,
      "currentShift": "休み",
      "newShift": "日勤",
      "reason": "理由を簡潔に（30文字以内）"
    }
  ]
}

JSON以外の場合（一般的な相談・質問の場合）：
通常のテキストで日本語で回答してください。

【ルール】
- staffId は必ずシフト表データに登場する識別子を使う（スタッフA等）
- day は 1〜31 の整数
- currentShift / newShift は上記「利用可能なシフト名」のみ使用`;

    return base + task;
  }

  // suggest または both → JSON形式で提案を要求
  task = `
【依頼】
このシフト表の問題点を見つけ、具体的な修正案を JSON形式 で提案してください。

【返答形式】
必ず以下のJSON形式のみで返答してください。前後に説明文・マークダウン記法・コードフェンスは一切不要です。

{
  "summary": "全体的な所感（1-2文、日本語）",
  "suggestions": [
    {
      "staffId": "スタッフA",
      "day": 15,
      "currentShift": "休み",
      "newShift": "日勤",
      "reason": "理由を簡潔に（30文字以内）"
    }
  ]
}

【ルール】
- staffId は必ずシフト表データに登場する識別子を使う
- day は 1〜31 の整数（対象月の日）
- currentShift / newShift は上記「利用可能なシフト名」のみ使用（他は使わない）
- 提案は最も重要な 3〜7個に絞る
- 修正不要な場合は suggestions を空配列 [] にする
- JSON以外の文字は一切含めないこと（重要）`;

  return base + task;
}

function deAnonymizeText(text) {
  // AIからの返答内のスタッフID（A, B, C...）を実名に戻す
  let result = text;
  // 長い順にreplace（スタッフAA -> スタッフA より先）
  const sortedKeys = Object.keys(aiAnonymizeMap).sort((a, b) => b.length - a.length);
  sortedKeys.forEach(anon => {
    const real = aiAnonymizeMap[anon];
    // 全置換（gフラグ付き正規表現）
    result = result.replace(new RegExp(anon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), real);
  });
  return result;
}

// 実名 → 匿名ID（自由記入欄の実名をAIに送る前に変換）
function anonymizeText(text) {
  if (!text) return text;
  let result = text;
  // 実名→匿名IDの逆引きマップを作る
  const reverseMap = {};
  Object.entries(aiAnonymizeMap).forEach(([anon, real]) => { reverseMap[real] = anon; });
  // 実名は短いものより長いもの優先（例：「水島花子」を「水島」より先に置換）
  const sortedNames = Object.keys(reverseMap).sort((a, b) => b.length - a.length);
  sortedNames.forEach(name => {
    if (!name) return;
    const anonId = reverseMap[name];
    // 「さん」「氏」などの敬称も含めて置換
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), anonId);
  });
  return result;
}

function showAiStep(step) {
  ['aiStepSelect','aiStepLoading','aiStepResult','aiStepError'].forEach(id => {
    document.getElementById(id).style.display = (id === step) ? 'block' : 'none';
  });
}

document.getElementById('aiAdviceBtn')?.addEventListener('click', () => {
  if (!shiftData || Object.keys(shiftData).length === 0) {
    showToast('シフト表が空です。先にシフトを生成または入力してください', 'error');
    return;
  }
  document.getElementById('aiTargetMonthLabel').textContent = `${shiftYear}年${shiftMonth}月`;
  document.getElementById('aiTargetDeptLabel').textContent = DEPT_NAMES[currentDept];
  showAiStep('aiStepSelect');
  document.getElementById('aiAdviceModal').style.display = 'flex';
});

document.getElementById('closeAiModal')?.addEventListener('click', () => {
  document.getElementById('aiAdviceModal').style.display = 'none';
});

document.getElementById('aiCloseFinishBtn')?.addEventListener('click', () => {
  document.getElementById('aiAdviceModal').style.display = 'none';
});

// AI返答からJSONを抽出（マークダウン記法も対応）
function extractJsonFromAiText(text) {
  let m = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (m) return m[1];
  m = text.match(/```\s*([\s\S]*?)\s*```/);
  if (m) return m[1];
  const start = text.indexOf('{');
  if (start < 0) return text;
  const end = text.lastIndexOf('}');
  if (end > start) return text.slice(start, end + 1);
  // 途中で切れたJSON：閉じ括弧を補完してみる
  let body = text.slice(start);
  // 最後の "..." の文字列を閉じる
  const lastQuote = body.lastIndexOf('"');
  if (lastQuote >= 0 && body.slice(0, lastQuote).split('"').length % 2 === 0) {
    // 偶数個の " で始まり、最後の " が閉じ忘れの場合は何もしない
    // 奇数個なら不完全な文字列。途切れた途中で適当に閉じる
    body = body.slice(0, lastQuote) + '"';
  }
  // 最後のオブジェクト/配列を閉じる
  let depth = 0;
  for (const ch of body) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  // 最後の不完全な要素を切り詰める
  // 最後の完全なオブジェクトの } を探す
  const lastObjEnd = body.lastIndexOf('},');
  if (lastObjEnd > 0 && depth > 0) {
    body = body.slice(0, lastObjEnd + 1);
  }
  // 残りの開き括弧分を閉じる
  const openObj = (body.match(/\{/g) || []).length;
  const closeObj = (body.match(/\}/g) || []).length;
  const openArr = (body.match(/\[/g) || []).length;
  const closeArr = (body.match(/\]/g) || []).length;
  for (let i = 0; i < openArr - closeArr; i++) body += ']';
  for (let i = 0; i < openObj - closeObj; i++) body += '}';
  return body;
}

function validateSuggestions(suggestions) {
  const validShifts = new Set(Object.keys(SHIFT_HOURS));
  validShifts.add('');
  // 実名→匿名ID の逆引きマップ
  const reverseMap = {};
  Object.entries(aiAnonymizeMap).forEach(([anon, real]) => { reverseMap[real] = anon; });
  return suggestions.filter(s => {
    if (!s.staffId || !s.day || !s.newShift) return false;
    if (!validShifts.has(s.newShift)) return false;
    if (s.day < 1 || s.day > 31) return false;
    // staffId が匿名IDでなくても、実名なら逆引きで匿名IDに変換
    if (!aiAnonymizeMap[s.staffId]) {
      if (reverseMap[s.staffId]) {
        s.staffId = reverseMap[s.staffId];  // 実名 → 匿名ID
      } else {
        return false;  // どちらにも該当しない
      }
    }
    return true;
  });
}

function calcShiftHours(shift, year, month, day) {
  if (!shift) return 0;
  const base = SHIFT_HOURS[shift] || 0;
  if (PAID_LEAVE_SHIFTS.includes(shift)) {
    const dt = new Date(year, month - 1, day);
    const hol = (typeof getJapaneseHolidays === 'function') ? getJapaneseHolidays(year, month) : new Set();
    return base + getYukyuHours(dt.getDay(), hol.has ? hol.has(day) : false);
  }
  if (shift === '半有休') return base + 5;
  return base;
}

function calcStaffTotalH(staffId) {
  const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
  let total = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const sh = shiftData[`${staffId}|${d}`] || '';
    total += calcShiftHours(sh, shiftYear, shiftMonth, d);
  }
  return Math.round(total * 10) / 10;
}

function renderSuggestionCard(suggestion, idx) {
  const realName = aiAnonymizeMap[suggestion.staffId] || suggestion.staffId;
  const staff = allStaff.find(s => s.name === realName && s.dept_id === currentDept);
  if (!staff) return '';
  const day = suggestion.day;
  const newShift = suggestion.newShift;
  const reason = suggestion.reason || '';
  const actualCurrent = shiftData[`${staff.id}|${day}`] || '';
  const aiCurrent = suggestion.currentShift || '';
  const mismatch = aiCurrent && aiCurrent !== actualCurrent;
  const before = calcStaffTotalH(staff.id);
  const dayHoursBefore = calcShiftHours(actualCurrent, shiftYear, shiftMonth, day);
  const dayHoursAfter = calcShiftHours(newShift, shiftYear, shiftMonth, day);
  const diff = Math.round((dayHoursAfter - dayHoursBefore) * 10) / 10;
  const afterTotal = Math.round((before + diff) * 10) / 10;
  const diffStr = diff >= 0 ? `+${diff}H` : `${diff}H`;
  const diffColor = diff > 0 ? '#dc2626' : diff < 0 ? '#2563eb' : '#6b7280';
  const dt = new Date(shiftYear, shiftMonth - 1, day);
  const dow = ['日','月','火','水','木','金','土'][dt.getDay()];
  const dateLabel = `${shiftMonth}/${day}(${dow})`;
  return `<div class="ai-card" data-idx="${idx}" style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin-bottom:10px;background:white">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <div>
        <div style="font-size:14px;font-weight:700;color:#1f2937">${realName} <span style="color:#94a3b8;font-weight:500;font-size:12px">${dateLabel}</span></div>
        <div style="font-size:12px;color:#6b7280;margin-top:2px">#${idx + 1}</div>
      </div>
      <span class="ai-applied-badge" data-idx="${idx}" style="display:none;background:#10b981;color:white;font-size:11px;font-weight:600;padding:3px 10px;border-radius:100px">✓ 適用済み</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:13px">
      <div style="background:#f3f4f6;color:#475569;padding:5px 12px;border-radius:8px;font-weight:600">${actualCurrent || '（空）'}</div>
      <span style="color:#94a3b8">→</span>
      <div style="background:#dbeafe;color:#1e40af;padding:5px 12px;border-radius:8px;font-weight:600">${newShift}</div>
      ${mismatch ? `<span style="font-size:10px;color:#f59e0b;background:#fef3c7;padding:2px 6px;border-radius:6px">⚠️ AI想定: ${aiCurrent}</span>` : ''}
    </div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:10px;line-height:1.5">${reason}</div>
    <div style="background:#f9fafb;border-radius:8px;padding:8px 10px;font-size:11px;color:#475569;margin-bottom:10px">
      労働時間: <span style="color:${diffColor};font-weight:700">${diffStr}</span> （合計 ${before}H → ${afterTotal}H）
    </div>
    <button class="btn btn-primary ai-apply-btn" data-idx="${idx}" style="font-size:12px;padding:6px 14px">この提案を適用</button>
  </div>`;
}

let aiCurrentSuggestions = [];

document.querySelectorAll('.ai-choice-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    aiCurrentMode = btn.dataset.mode;
    showAiStep('aiStepLoading');
    try {
      const prompt = buildPromptForAI(aiCurrentMode);
      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data?.error || `エラー (${res.status})`;
        document.getElementById('aiErrorText').textContent = msg + (data?.detail ? '\n' + data.detail : '');
        showAiStep('aiStepError');
        return;
      }

      const rawText = data.text || '';

      if (aiCurrentMode === 'problems') {
        document.getElementById('aiSummaryBox').style.display = 'none';
        document.getElementById('aiSuggestionsList').innerHTML = '';
        document.getElementById('aiResultTextBox').style.display = 'block';
        document.getElementById('aiResultText').textContent = deAnonymizeText(rawText);
        showAiStep('aiStepResult');
        return;
      }

      let parsed;
      try {
        const jsonStr = extractJsonFromAiText(rawText);
        parsed = JSON.parse(jsonStr);
      } catch(parseErr) {
        // custom モードではJSONが来ない普通の質問もありうる→普通に表示
        // both モードではJSONが期待されているので警告を出す
        document.getElementById('aiSummaryBox').style.display = 'none';
        if (aiCurrentMode === 'custom') {
          document.getElementById('aiSuggestionsList').innerHTML = '';
        } else {
          document.getElementById('aiSuggestionsList').innerHTML = '<div style="background:#fef3c7;color:#92400e;padding:12px;border-radius:10px;font-size:12px;margin-bottom:10px">⚠️ AIの返答からJSON形式の提案を取り出せませんでした。下記の本文をご確認ください。</div>';
        }
        document.getElementById('aiResultTextBox').style.display = 'block';
        document.getElementById('aiResultText').textContent = deAnonymizeText(rawText);
        showAiStep('aiStepResult');
        return;
      }

      const summary = parsed.summary || '';
      if (summary) {
        document.getElementById('aiSummaryBox').style.display = 'block';
        document.getElementById('aiSummaryText').textContent = deAnonymizeText(summary);
      } else {
        document.getElementById('aiSummaryBox').style.display = 'none';
      }

      const rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
      aiCurrentSuggestions = validateSuggestions(rawSuggestions);

      const listEl = document.getElementById('aiSuggestionsList');
      if (aiCurrentSuggestions.length === 0) {
        listEl.innerHTML = '<div style="background:#f0fdf4;color:#166534;padding:14px;border-radius:10px;font-size:13px;margin-bottom:10px;text-align:center">✓ 修正の必要はありません</div>';
      } else {
        listEl.innerHTML = aiCurrentSuggestions.map((s, idx) => renderSuggestionCard(s, idx)).join('');
        document.querySelectorAll('.ai-apply-btn').forEach(b => {
          b.addEventListener('click', () => applyAiSuggestion(parseInt(b.dataset.idx, 10)));
        });
      }

      document.getElementById('aiResultTextBox').style.display = 'none';
      showAiStep('aiStepResult');
    } catch(e) {
      console.error(e);
      document.getElementById('aiErrorText').textContent = 'ネットワークエラー：' + (e.message || '') + '\n\n/api/gemini が見つからない場合は、Vercel Functions（/api/gemini.js）が正しくデプロイされているか確認してください。';
      showAiStep('aiStepError');
    }
  });
});

function applyAiSuggestion(idx) {
  const sug = aiCurrentSuggestions[idx];
  if (!sug) return;
  const realName = aiAnonymizeMap[sug.staffId];
  const staff = allStaff.find(s => s.name === realName && s.dept_id === currentDept);
  if (!staff) {
    showToast('対象スタッフが見つかりません', 'error');
    return;
  }

  console.log('[AI適用] スタッフ:', realName, 'ID:', staff.id, '日:', sug.day, '→', sug.newShift);

  const key = `${staff.id}|${sug.day}`;
  // データ更新
  if (typeof saveUndoState === 'function') saveUndoState();
  shiftData[key] = sug.newShift;
  lockedCells[key] = true;  // ロック

  // === 確実に反映するための処理 ===
  // 1. セル表示更新を試みる
  let displayUpdated = false;
  if (typeof updateCellDisplay === 'function') {
    try {
      updateCellDisplay(key);
      // 反映確認：セル要素の表示テキストが newShift と一致するか
      const cellEl = document.querySelector(`[data-staff="${staff.id}"][data-day="${sug.day}"][data-grid="shiftGrid"]`);
      if (cellEl) {
        const txtEl = cellEl.querySelector('.shift-text');
        if (txtEl && txtEl.textContent === sug.newShift) {
          displayUpdated = true;
        }
      }
    } catch(e) {
      console.error('[AI適用] updateCellDisplayエラー:', e);
    }
  }

  // 2. 累計時間更新
  if (typeof refreshHoursCell === 'function') {
    try { refreshHoursCell(staff.id); } catch(e) { console.error('[AI適用] refreshHoursCellエラー:', e); }
  }

  // 3. サマリー行（必要人数充足など）の更新
  if (typeof refreshSummaryRows === 'function') {
    try { refreshSummaryRows(); } catch(e) { console.error('[AI適用] refreshSummaryRowsエラー:', e); }
  }

  // 4. もし1のセル更新が失敗したら、シフト表全体を再描画（DB再取得なし）
  if (!displayUpdated) {
    console.log('[AI適用] セル個別更新が確認できなかったため全体再描画');
    try {
      const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });
      const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
      // 既存の reqMap, shiftWedTypes をなるべく使う
      if (typeof renderShiftGrid === 'function' && typeof window._shiftReqMap !== 'undefined') {
        renderShiftGrid('shiftGrid', deptStaff, daysInMonth, shiftYear, shiftMonth, shiftData, window._shiftReqMap, lockedCells, true, window._shiftWedTypes || {});
      }
    } catch(e) {
      console.error('[AI適用] 全体再描画エラー:', e);
    }
  }

  // 適用済みバッジ
  const badge = document.querySelector(`.ai-applied-badge[data-idx="${idx}"]`);
  if (badge) badge.style.display = 'inline-block';
  const btn = document.querySelector(`.ai-apply-btn[data-idx="${idx}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '✓ 適用済み';
    btn.style.opacity = '0.6';
    btn.style.cursor = 'default';
  }

  showToast(`${realName}さんの ${shiftMonth}/${sug.day} を ${sug.newShift} に変更しました（保存ボタンで確定）`, 'success');
}

document.getElementById('aiBackBtn')?.addEventListener('click', () => {
  showAiStep('aiStepSelect');
});

document.getElementById('aiErrorBackBtn')?.addEventListener('click', () => {
  showAiStep('aiStepSelect');
});
// =====================================================
// 希望提出期限管理（フェーズ5）
// =====================================================
let deadlineDept = 0;

function calcDefaultDeadline(year, month, daysBefore, hour, minute) {
  // 対象月の1日からdaysBefore日前
  const targetDate = new Date(year, month - 1, 1);
  targetDate.setDate(targetDate.getDate() - daysBefore);
  targetDate.setHours(hour || 23, minute || 59, 59, 0);
  return targetDate;
}

function formatDateTime(d) {
  if (!d) return '―';
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yy}/${mm}/${dd} ${hh}:${mi}`;
}

async function loadDeadlinePage() {
  const card = document.getElementById('deadlineCard');
  // master または leader だけ表示
  if (!adminUser || (adminUser.role !== 'master' && adminUser.role !== 'leader')) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';

  // 部門タブ
  const tabs = document.getElementById('deadlineDeptTabs');
  if (tabs && !tabs.dataset.built) {
    tabs.innerHTML = '';
    const depts = adminUser.role === 'master' ? Object.entries(DEPT_NAMES) : [[adminUser.deptId, DEPT_NAMES[adminUser.deptId]]];
    depts.forEach(([id, name]) => {
      const btn = document.createElement('button');
      btn.className = `dept-tab${parseInt(id) === deadlineDept ? ' active' : ''}`;
      btn.textContent = name;
      btn.dataset.dept = id;
      btn.addEventListener('click', async () => {
        deadlineDept = parseInt(btn.dataset.dept, 10);
        tabs.querySelectorAll('.dept-tab').forEach(t => t.classList.toggle('active', parseInt(t.dataset.dept,10) === deadlineDept));
        await fetchDeadline();
      });
      tabs.appendChild(btn);
    });
    tabs.dataset.built = '1';
  }
  await fetchDeadline();
}

// 「Nヶ月前のX日 H:M」ルールから対象月の期限を計算
// 対象月Mのシフト → N ヶ月前のX日 H:M が期限
// monthsBefore: 1=前月, 2=2ヶ月前, 3=3ヶ月前
function calcDeadlineFromRule(year, month, dayOfMonth, hour, minute, monthsBefore) {
  const mb = monthsBefore || 1;
  // 対象月から mb ヶ月引いた年月を計算
  let py = year, pm = month - mb;
  while (pm < 1) { pm += 12; py--; }
  // 対象月の最終日を超える場合は末日に丸める（例：「31日」で2月なら28/29日）
  const lastDay = new Date(py, pm, 0).getDate();
  const d = Math.min(dayOfMonth, lastDay);
  return new Date(py, pm - 1, d, hour, minute, 59, 0);
}

async function fetchDeadline() {
  try {
    // 「毎月X日」ルールを取得
    const rules = await sb(`shift_request_deadline_rules?dept_id=eq.${deadlineDept}&select=*`);
    const rule = rules[0] || null;
    if (rule && rule.days_before != null) {
      // days_before カラムを「日付」として再利用
      document.getElementById('deadlineDay').value = rule.days_before;
      document.getElementById('deadlineTime').value = `${String(rule.hour||23).padStart(2,'0')}:${String(rule.minute||59).padStart(2,'0')}`;
      document.getElementById('deadlineMonthsBefore').value = String(rule.months_before || 1);
    } else {
      document.getElementById('deadlineDay').value = '';
      document.getElementById('deadlineTime').value = '23:59';
      document.getElementById('deadlineMonthsBefore').value = '1';
    }

    // 例文の更新
    updateDeadlineExample();

    // 適用状況の表示
    const effEl = document.getElementById('deadlineEffective');
    if (rule && rule.days_before != null) {
      const effective = calcDeadlineFromRule(shiftYear, shiftMonth, rule.days_before, rule.hour||23, rule.minute||59, rule.months_before||1);
      const now = new Date();
      const passed = now > effective;
      effEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div><strong>${shiftYear}年${shiftMonth}月の期限：</strong>${formatDateTime(effective)}</div>
        <div>${passed ? '<span style="color:#dc2626;font-weight:700">⏰ 期限切れ</span>' : '<span style="color:#16a34a;font-weight:700">✓ 受付中</span>'}</div>
      </div>`;
    } else {
      effEl.innerHTML = `<div style="color:var(--text-muted)"><strong>${shiftYear}年${shiftMonth}月：</strong>期限なし（いつでも提出可）</div>`;
    }
  } catch(e) {
    console.error('期限取得エラー', e);
  }
}

// 例文の更新（月数や日付変更時）
function updateDeadlineExample() {
  const mb = parseInt(document.getElementById('deadlineMonthsBefore')?.value || '1', 10);
  const d = document.getElementById('deadlineDay')?.value || '10';
  const t = document.getElementById('deadlineTime')?.value || '23:59';
  const mbLabel = mb === 1 ? '前月' : `${mb}ヶ月前`;
  // 例として5月シフトの場合を計算
  const exampleMonth = 5;
  let pm = exampleMonth - mb;
  while (pm < 1) pm += 12;
  const exampleEl = document.getElementById('deadlineExampleText');
  if (exampleEl) {
    exampleEl.textContent = `例：「${mbLabel}の${d}日 ${t}」=5月分シフトの提出期限は${pm}/${d} ${t}`;
  }
}

// 月数・日付・時刻の変更時に例文を更新
document.getElementById('deadlineMonthsBefore')?.addEventListener('change', updateDeadlineExample);
document.getElementById('deadlineDay')?.addEventListener('input', updateDeadlineExample);
document.getElementById('deadlineTime')?.addEventListener('change', updateDeadlineExample);

document.getElementById('saveDeadlineRuleBtn')?.addEventListener('click', async () => {
  const dayVal = parseInt(document.getElementById('deadlineDay').value, 10);
  const time = document.getElementById('deadlineTime').value || '23:59';
  const [h, m] = time.split(':').map(Number);
  const monthsBefore = parseInt(document.getElementById('deadlineMonthsBefore').value, 10) || 1;
  if (isNaN(dayVal) || dayVal < 1 || dayVal > 31) {
    showToast('日は1〜31の整数で入力してください', 'error');
    return;
  }
  showLoading();
  try {
    const existing = await sb(`shift_request_deadline_rules?dept_id=eq.${deadlineDept}&select=dept_id`);
    // days_before カラムを「日」として使う
    const payload = { dept_id: deadlineDept, days_before: dayVal, hour: h, minute: m, months_before: monthsBefore };
    if (existing && existing.length > 0) {
      await sb(`shift_request_deadline_rules?dept_id=eq.${deadlineDept}`, {method:'PATCH', body: JSON.stringify(payload)});
    } else {
      await sb('shift_request_deadline_rules', {method:'POST', body: JSON.stringify([payload])});
    }
    showToast('提出期限ルールを保存しました ✓', 'success');
    await fetchDeadline();
  } catch(e) {
    console.error(e);
    showToast('保存エラー：' + (e.message||''), 'error');
  }
  hideLoading();
});

document.getElementById('clearDeadlineRuleBtn')?.addEventListener('click', async () => {
  if (!confirm(`${DEPT_NAMES[deadlineDept]}の提出期限ルールを解除しますか？\n期限なし（いつでも提出可）になります。`)) return;
  showLoading();
  try {
    await sb(`shift_request_deadline_rules?dept_id=eq.${deadlineDept}`, {method:'DELETE'});
    showToast('期限ルールを解除しました', 'success');
    await fetchDeadline();
  } catch(e) {
    console.error(e);
    showToast('エラー：' + (e.message||''), 'error');
  }
  hideLoading();
});

// =====================================================
// バーチカル表示（フェーズ3）
// =====================================================
let verticalCurrentDay = 1;       // 現在表示中の日
let verticalBreaksCache = {};     // {staffId: [{break_start, break_end, id?}, ...]}
let verticalBreaksLoaded = false; // ロード済みフラグ
let verticalBreaksOriginal = {};  // ロード時の状態（保存判定用）

// 時刻文字列を分単位の数値に変換 ("08:30" → 510)
function timeStrToMin(t) {
  if (!t || typeof t !== 'string') return 0;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// 分単位の数値を時刻文字列に変換 (510 → "08:30")
function minToTimeStr(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// その日の休憩データをDBから取得
async function loadDayBreaks(year, month, day) {
  try {
    const data = await sb(`shift_breaks?year=eq.${year}&month=eq.${month}&day=eq.${day}&order=staff_id,display_order&select=*`);
    const breaks = {};
    data.forEach(b => {
      if (!breaks[b.staff_id]) breaks[b.staff_id] = [];
      breaks[b.staff_id].push({
        id: b.id,
        break_start: b.break_start,
        break_end: b.break_end
      });
    });
    return breaks;
  } catch(e) {
    console.error('休憩データ取得エラー', e);
    return {};
  }
}

// バーチカル表示を開く
window.openVerticalView = async function(day) {
  verticalCurrentDay = day;
  showLoading();
  try {
    // 休憩データをロード
    verticalBreaksCache = await loadDayBreaks(shiftYear, shiftMonth, day);
    // 元の状態を保存（保存判定用にディープコピー）
    verticalBreaksOriginal = JSON.parse(JSON.stringify(verticalBreaksCache));
    verticalBreaksLoaded = true;
    renderVerticalView();
    document.getElementById('verticalViewModal').classList.add('show');
  } catch(e) {
    console.error(e);
    showToast('読み込みエラー', 'error');
  }
  hideLoading();
};

// バーチカル表示を描画
function renderVerticalView() {
  const day = verticalCurrentDay;
  const dow = new Date(shiftYear, shiftMonth-1, day).getDay();
  const dowJp = ['日','月','火','水','木','金','土'][dow];
  document.getElementById('verticalViewTitle').textContent = 
    `${shiftYear}年${shiftMonth}月${day}日(${dowJp}) ${DEPT_NAMES[currentDept]} バーチカル表示`;

  const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
  
  // その日に勤務するスタッフだけを抽出（休み系・空セル除外）
  const workingStaff = deptStaff.filter(s => {
    const sh = shiftData[`${s.id}|${day}`];
    if (!sh) return false;
    if (OFF_SHIFTS.includes(sh)) return false;
    // 時間が定義されているシフトのみ
    const st = shiftTypesAll.find(x => x.id === sh);
    if (!st || !st.start_time || !st.end_time) return false;
    return true;
  });

  if (workingStaff.length === 0) {
    document.getElementById('verticalViewContent').innerHTML = 
      '<div style="padding:40px;text-align:center;color:var(--text-muted)">この日に勤務するスタッフはいません</div>';
    return;
  }

  // 時間軸：8:30 〜 21:30（10分単位）
  const startMin = 8 * 60 + 30;  // 510
  const endMin = 21 * 60 + 30;   // 1290
  const totalMinutes = endMin - startMin; // 780分
  const pixelsPerMin = 1.6; // 1分=1.6px、780分=1248px
  const timelineWidth = totalMinutes * pixelsPerMin;
  
  // 時間目盛り（30分ごとにラベル、1時間ごとに濃い線）
  let timelineHeader = '<div style="position:relative;height:32px;border-bottom:2px solid var(--border);background:#f8fafc">';
  // 10分単位の小目盛り（一番下の短い線）
  for (let m = startMin; m <= endMin; m += 10) {
    const left = (m - startMin) * pixelsPerMin;
    const isHalf = (m % 30 === 0);
    const isHour = (m % 60 === 0);
    if (isHour) {
      // 1時間：濃い縦線（ヘッダー高さ全体）
      timelineHeader += `<div style="position:absolute;left:${left}px;top:0;height:100%;border-left:1px solid #94a3b8"></div>`;
    } else if (isHalf) {
      // 30分：薄い縦線
      timelineHeader += `<div style="position:absolute;left:${left}px;top:0;height:100%;border-left:1px solid #cbd5e1"></div>`;
    } else {
      // 10分：底辺だけの短い線
      timelineHeader += `<div style="position:absolute;left:${left}px;bottom:0;height:6px;border-left:1px solid #e2e8f0"></div>`;
    }
    // 30分ごとに時刻ラベル
    if (isHalf) {
      timelineHeader += `<div style="position:absolute;left:${left+2}px;top:6px;font-size:10px;color:${isHour?'#475569':'#94a3b8'};font-weight:${isHour?'700':'500'}">${minToTimeStr(m)}</div>`;
    }
  }
  timelineHeader += '</div>';

  // 各スタッフの行
  let rows = '';
  workingStaff.forEach(staff => {
    const sh = shiftData[`${staff.id}|${day}`];
    const st = shiftTypesAll.find(x => x.id === sh);
    const shiftStart = timeStrToMin(st.start_time);
    const shiftEnd = timeStrToMin(st.end_time);
    
    // 表示範囲外チェック
    if (shiftEnd <= startMin || shiftStart >= endMin) return;
    
    // 帯の表示位置
    const barStart = Math.max(shiftStart, startMin);
    const barEnd = Math.min(shiftEnd, endMin);
    const barLeft = (barStart - startMin) * pixelsPerMin;
    const barWidth = (barEnd - barStart) * pixelsPerMin;
    
    // シフトの色クラス
    const colorClass = SHIFT_COLORS[sh] || 'sc-custom';
    
    // 休憩を計算
    const breaks = verticalBreaksCache[staff.id] || [];
    let breaksHtml = '';
    breaks.forEach((b, idx) => {
      const bs = timeStrToMin(b.break_start);
      const be = timeStrToMin(b.break_end);
      if (be <= barStart || bs >= barEnd) return;
      const bsClamp = Math.max(bs, barStart);
      const beClamp = Math.min(be, barEnd);
      const bLeft = (bsClamp - startMin) * pixelsPerMin;
      const bWidth = (beClamp - bsClamp) * pixelsPerMin;
      const breakDur = beClamp - bsClamp;
      // 帯の幅に応じて表示内容を調整
      let breakContent = '';
      if (bWidth >= 80) {
        // 幅広：「休憩 12:30-13:30」
        breakContent = `<div style="font-size:9px;line-height:1.2;text-align:center"><div>休憩</div><div style="font-size:8px;font-weight:600">${b.break_start}-${b.break_end}</div></div>`;
      } else if (bWidth >= 40) {
        // 中幅：「12:30」だけ
        breakContent = `<div style="font-size:8px;font-weight:600;line-height:1">${b.break_start}<br><span style="opacity:0.7">-${b.break_end}</span></div>`;
      } else {
        // 狭い：何も表示しない
        breakContent = '';
      }
      breaksHtml += `<div style="position:absolute;left:${bLeft}px;top:0;width:${bWidth}px;height:100%;background:white;border-left:1px dashed #94a3b8;border-right:1px dashed #94a3b8;display:flex;align-items:center;justify-content:center;color:#64748b;pointer-events:none;overflow:hidden">${breakContent}</div>`;
    });

    // スタッフ属性
    const empBadge = staff.emp_type === 'short' ? '<span style="font-size:9px;color:#0f766e;background:#ccfbf1;padding:1px 4px;border-radius:3px;margin-left:4px">時短</span>' 
      : staff.emp_type === 'part' ? '<span style="font-size:9px;color:#6b7280;background:#f3f4f6;padding:1px 4px;border-radius:3px;margin-left:4px">パート</span>'
      : '';

    rows += `<div style="display:flex;align-items:stretch;border-bottom:1px solid #e2e8f0">
      <div style="min-width:140px;padding:8px 10px;background:#f8fafc;border-right:1px solid #e2e8f0;display:flex;align-items:center;font-size:13px;font-weight:600;white-space:nowrap">
        ${escapeHtml(staff.name)}${empBadge}
      </div>
      <div style="position:relative;height:44px;width:${timelineWidth}px;background:#fafafa">
        <div class="${colorClass} v-shift-bar" style="position:absolute;left:${barLeft}px;top:6px;width:${barWidth}px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:flex-start;padding-left:8px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid rgba(0,0,0,0.1);box-shadow:0 1px 2px rgba(0,0,0,0.06);overflow:hidden;white-space:nowrap" 
          data-staff-id="${staff.id}"
          data-staff-name="${escapeHtml(staff.name)}"
          data-shift-start="${st.start_time}"
          data-shift-end="${st.end_time}"
          title="クリックで休憩編集 (${escapeHtml(sh)} ${st.start_time}-${st.end_time})">${escapeHtml(sh)} ${st.start_time}-${st.end_time}</div>
        ${breaksHtml}
      </div>
    </div>`;
  });

  document.getElementById('verticalViewContent').innerHTML = 
    `<div style="display:inline-block;min-width:100%">
      <div style="display:flex">
        <div style="min-width:140px;background:#e0e7ff;border-right:1px solid #94a3b8;border-bottom:2px solid var(--border);padding:6px 10px;font-size:12px;font-weight:700;color:#3730a3;display:flex;align-items:center">スタッフ</div>
        ${timelineHeader.replace('<div style="position:relative;height:32px', `<div style="position:relative;height:32px;width:${timelineWidth}px`)}
      </div>
      ${rows}
    </div>`;

  // 帯クリックイベントをまとめて設定（data属性方式）
  document.querySelectorAll('#verticalViewContent .v-shift-bar').forEach(el => {
    el.addEventListener('click', () => {
      const sid = el.dataset.staffId;
      const sname = el.dataset.staffName;
      const sstart = el.dataset.shiftStart;
      const send = el.dataset.shiftEnd;
      // staff_idの型を考慮（数値型と文字列型の両方に対応）
      const sidParsed = /^\d+$/.test(sid) ? parseInt(sid, 10) : sid;
      openBreakEdit(sidParsed, sname, sstart, send);
    });
  });
}

// 前日・翌日ナビ
document.getElementById('verticalPrevDay')?.addEventListener('click', async () => {
  if (verticalCurrentDay <= 1) return;
  // 未保存の休憩編集を確認
  if (hasUnsavedBreaks()) {
    if (!confirm('休憩の編集が未保存です。破棄して移動しますか？')) return;
  }
  await openVerticalView(verticalCurrentDay - 1);
});

document.getElementById('verticalNextDay')?.addEventListener('click', async () => {
  const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
  if (verticalCurrentDay >= daysInMonth) return;
  if (hasUnsavedBreaks()) {
    if (!confirm('休憩の編集が未保存です。破棄して移動しますか？')) return;
  }
  await openVerticalView(verticalCurrentDay + 1);
});

function hasUnsavedBreaks() {
  return JSON.stringify(verticalBreaksCache) !== JSON.stringify(verticalBreaksOriginal);
}

// 休憩編集モーダルを開く
let breakEditStaffId = null;
let breakEditList = []; // [{break_start, break_end}, ...]
window.openBreakEdit = function(staffId, staffName, shiftStart, shiftEnd) {
  breakEditStaffId = staffId;
  breakEditList = (verticalBreaksCache[staffId] || []).map(b => ({
    break_start: b.break_start,
    break_end: b.break_end,
    id: b.id
  }));
  document.getElementById('breakEditTitle').textContent = `${staffName}の休憩時間（${shiftStart}〜${shiftEnd}）`;
  renderBreakEditList();
  document.getElementById('breakEditModal').classList.add('show');
};

function renderBreakEditList() {
  const el = document.getElementById('breakEditList');
  if (breakEditList.length === 0) {
    el.innerHTML = '<div style="color:var(--text-muted);padding:16px;text-align:center;font-size:13px">休憩なし</div>';
    return;
  }
  el.innerHTML = breakEditList.map((b, idx) => {
    // 何分間か計算
    const durMin = timeStrToMin(b.break_end) - timeStrToMin(b.break_start);
    return `
    <div style="margin-bottom:12px;padding:10px;background:#f8fafc;border-radius:8px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <span style="font-size:12px;color:var(--text-muted);min-width:50px;font-weight:600">休憩${idx+1}</span>
        <span style="font-size:12px;color:var(--text-muted)">開始</span>
        <input type="time" class="form-input" style="flex:1" value="${b.break_start}" 
          step="600" data-break-idx="${idx}" data-break-field="break_start">
        <span style="font-size:12px;color:var(--text-muted)">時間</span>
        <input type="number" class="form-input" style="width:80px" min="10" max="240" step="10" 
          value="${durMin}" data-break-idx="${idx}" data-break-field="duration">
        <span style="font-size:12px">分</span>
        <button class="btn btn-outline" style="padding:4px 10px;color:#dc2626" data-remove-break="${idx}">×</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;padding-left:60px">
        <button class="btn-preset" data-preset-idx="${idx}" data-preset-min="30" style="padding:4px 12px;background:#e0e7ff;color:#4338ca;border:1px solid #c7d2fe;border-radius:6px;font-size:11px;cursor:pointer">30分</button>
        <button class="btn-preset" data-preset-idx="${idx}" data-preset-min="45" style="padding:4px 12px;background:#e0e7ff;color:#4338ca;border:1px solid #c7d2fe;border-radius:6px;font-size:11px;cursor:pointer">45分</button>
        <button class="btn-preset" data-preset-idx="${idx}" data-preset-min="60" style="padding:4px 12px;background:#e0e7ff;color:#4338ca;border:1px solid #c7d2fe;border-radius:6px;font-size:11px;cursor:pointer">60分</button>
        <button class="btn-preset" data-preset-idx="${idx}" data-preset-min="90" style="padding:4px 12px;background:#e0e7ff;color:#4338ca;border:1px solid #c7d2fe;border-radius:6px;font-size:11px;cursor:pointer">90分</button>
      </div>
    </div>`;
  }).join('');

  // イベントリスナー設定（time/numberの変更）
  el.querySelectorAll('input[data-break-idx]').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.breakIdx, 10);
      const field = e.target.dataset.breakField;
      const value = e.target.value;
      if (!breakEditList[idx]) return;
      if (field === 'break_start') {
        // 開始時間を変更したら、duration を維持して終了時間を再計算
        const durMin = timeStrToMin(breakEditList[idx].break_end) - timeStrToMin(breakEditList[idx].break_start);
        breakEditList[idx].break_start = value;
        breakEditList[idx].break_end = minToTimeStr(timeStrToMin(value) + durMin);
        renderBreakEditList();
      } else if (field === 'duration') {
        const dur = parseInt(value, 10) || 60;
        breakEditList[idx].break_end = minToTimeStr(timeStrToMin(breakEditList[idx].break_start) + dur);
        renderBreakEditList();
      }
    });
  });

  // プリセットボタン
  el.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.presetIdx, 10);
      const dur = parseInt(btn.dataset.presetMin, 10);
      if (!breakEditList[idx]) return;
      breakEditList[idx].break_end = minToTimeStr(timeStrToMin(breakEditList[idx].break_start) + dur);
      renderBreakEditList();
    });
  });

  // 削除ボタン
  el.querySelectorAll('[data-remove-break]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.removeBreak, 10);
      breakEditList.splice(idx, 1);
      renderBreakEditList();
    });
  });
}

window.updateBreak = function(idx, field, value) {
  if (!breakEditList[idx]) return;
  breakEditList[idx][field] = value;
};

window.removeBreak = function(idx) {
  breakEditList.splice(idx, 1);
  renderBreakEditList();
};

document.getElementById('addBreakBtn')?.addEventListener('click', () => {
  breakEditList.push({ break_start: '12:30', break_end: '13:30' });
  renderBreakEditList();
});

document.getElementById('applyBreakEditBtn')?.addEventListener('click', () => {
  // バリデーション
  for (const b of breakEditList) {
    if (!b.break_start || !b.break_end) {
      showToast('休憩の開始・終了時間を入力してください', 'error');
      return;
    }
    if (timeStrToMin(b.break_start) >= timeStrToMin(b.break_end)) {
      showToast('休憩の終了時間は開始時間より後にしてください', 'error');
      return;
    }
    // 10分単位チェック
    if (timeStrToMin(b.break_start) % 10 !== 0 || timeStrToMin(b.break_end) % 10 !== 0) {
      showToast('休憩時間は10分単位で設定してください', 'error');
      return;
    }
  }
  verticalBreaksCache[breakEditStaffId] = breakEditList.map(b => ({
    break_start: b.break_start,
    break_end: b.break_end,
    id: b.id
  }));
  closeModal('breakEditModal');
  renderVerticalView();
});

// 休憩を保存（DBへ）
// 印刷ボタン（バーチカル表示用）
document.getElementById('verticalPrintBtn')?.addEventListener('click', () => {
  // ★ バーチカル印刷モード時のみ body にクラスを付与（シフト表印刷との分離）
  document.body.classList.add('printing-vertical');
  // 8:30〜21:30 の全幅（名前列＋タイムライン）を A4横の用紙幅に収めるための縮小率を実幅から算出
  const content = document.getElementById('verticalViewContent');
  if (content) {
    const contentW = content.scrollWidth || 1; // 名前列＋タイムライン全幅(px)
    const TARGET_PRINT_W = 1010; // A4横・余白込みの印刷可能幅(約)px@96dpi。超過時のみ縮小
    const scale = Math.min(1, TARGET_PRINT_W / contentW);
    content.style.setProperty('--v-print-scale', scale);
  }
  // ★ クラス除去は固定タイマーではなく afterprint で行う。
  //   print() が非同期な環境や、プレビューで向き変更などに時間がかかっても、
  //   印刷ダイアログが閉じるまで printing-vertical を保持し続ける（途中でシフト表に化けるのを防ぐ）。
  const cleanup = () => {
    document.body.classList.remove('printing-vertical');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
    });
  });
});

document.getElementById('saveBreaksBtn')?.addEventListener('click', async () => {
  showLoading();
  try {
    // その日の既存データを全削除してから新規挿入（簡潔）
    await sb(`shift_breaks?year=eq.${shiftYear}&month=eq.${shiftMonth}&day=eq.${verticalCurrentDay}`, {method:'DELETE'});
    
    // 新規挿入
    const inserts = [];
    Object.entries(verticalBreaksCache).forEach(([staffId, breaks]) => {
      breaks.forEach((b, idx) => {
        inserts.push({
          staff_id: parseInt(staffId, 10),
          year: shiftYear,
          month: shiftMonth,
          day: verticalCurrentDay,
          break_start: b.break_start,
          break_end: b.break_end,
          display_order: idx
        });
      });
    });
    if (inserts.length > 0) {
      await sb('shift_breaks', {method:'POST', body: JSON.stringify(inserts)});
    }
    verticalBreaksOriginal = JSON.parse(JSON.stringify(verticalBreaksCache));
    showToast('休憩を保存しました ✓', 'success');
  } catch(e) {
    console.error(e);
    showToast('保存エラー：' + (e.message || ''), 'error');
  }
  hideLoading();
});

// =====================================================
// シフトパターン管理（フェーズ1）
// =====================================================
let shiftPatternsCache = [];

async function loadShiftPatterns() {
  try {
    shiftPatternsCache = await sb('shift_types?order=display_order,id&select=*');
    renderShiftPatternsList();
  } catch(e) {
    console.error('シフトパターン読み込みエラー', e);
    document.getElementById('shiftPatternsList').innerHTML = '<div style="color:#dc2626;padding:16px">読み込みエラー</div>';
  }
}

function renderShiftPatternsList() {
  // 休み系（is_off=true）は除外して表示（管理対象外）
  const list = shiftPatternsCache.filter(s => !s.is_off);
  if (!list.length) {
    document.getElementById('shiftPatternsList').innerHTML = '<div style="color:var(--text-muted);padding:16px">シフトパターンがありません</div>';
    return;
  }
  let html = '<table class="req-table" style="min-width:900px"><thead><tr>';
  html += '<th style="text-align:left">シフト名</th>';
  html += '<th>時間</th>';
  html += '<th>実働</th>';
  html += '<th>午前</th><th>午後</th><th>夜間</th>';
  html += '<th>夜勤</th><th>遅番</th><th>長日</th><th>中抜</th>';
  html += '<th>種別</th>';
  html += '<th>操作</th>';
  html += '</tr></thead><tbody>';
  list.forEach(s => {
    const isDefault = !!s.is_default;
    const time = (s.start_time && s.end_time) ? `${s.start_time}-${s.end_time}` : '-';
    const checkmark = (v) => v ? '<span style="color:#16a34a;font-weight:700">✓</span>' : '<span style="color:#cbd5e1">−</span>';
    html += `<tr>
      <td style="text-align:left;font-weight:600">${escapeHtml(s.label || s.id)}</td>
      <td style="font-size:12px">${time}</td>
      <td>${(s.work_hours||0).toFixed(1)}h</td>
      <td>${checkmark(s.covers_morning)}</td>
      <td>${checkmark(s.covers_afternoon)}</td>
      <td>${checkmark(s.covers_evening)}</td>
      <td>${checkmark(s.is_night)}</td>
      <td>${checkmark(s.is_late)}</td>
      <td>${checkmark(s.is_long)}</td>
      <td>${checkmark(s.is_mid_break)}</td>
      <td>${isDefault ? '<span style="background:#e0e7ff;color:#4338ca;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">既定</span>' : '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">カスタム</span>'}</td>
      <td>${isDefault ? '<span style="color:var(--text-muted);font-size:11px">編集不可</span>' : `<button class="btn-icon" onclick="editCustomShift('${escapeHtml(s.id)}')" title="編集">✏️</button> <button class="btn-icon" onclick="deleteCustomShift('${escapeHtml(s.id)}')" title="削除" style="color:#dc2626">🗑</button>`}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  document.getElementById('shiftPatternsList').innerHTML = html;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 追加ボタン
document.getElementById('addCustomShiftBtn')?.addEventListener('click', () => {
  document.getElementById('customShiftModalTitle').textContent = 'カスタムシフト追加';
  document.getElementById('customShiftEditId').value = '';
  document.getElementById('customShiftName').value = '';
  document.getElementById('customShiftStart').value = '';
  document.getElementById('customShiftEnd').value = '';
  document.getElementById('customShiftHours').value = '';
  document.getElementById('customCoverMorning').checked = false;
  document.getElementById('customCoverAfternoon').checked = false;
  document.getElementById('customCoverEvening').checked = false;
  document.getElementById('customIsNight').checked = false;
  document.getElementById('customIsLate').checked = false;
  document.getElementById('customIsLong').checked = false;
  document.getElementById('customIsMidBreak').checked = false;
  // 名前フィールドを編集可能に
  document.getElementById('customShiftName').readOnly = false;
  openModal('customShiftModal');
});

// 編集
window.editCustomShift = function(id) {
  const s = shiftPatternsCache.find(x => x.id === id);
  if (!s) { showToast('シフトが見つかりません', 'error'); return; }
  if (s.is_default) { showToast('既定シフトは編集できません', 'error'); return; }
  document.getElementById('customShiftModalTitle').textContent = 'カスタムシフト編集';
  document.getElementById('customShiftEditId').value = s.id;
  document.getElementById('customShiftName').value = s.label || s.id;
  document.getElementById('customShiftName').readOnly = true; // 編集時は名前変更不可（idと連動するため）
  document.getElementById('customShiftStart').value = s.start_time || '';
  document.getElementById('customShiftEnd').value = s.end_time || '';
  document.getElementById('customShiftHours').value = s.work_hours || 0;
  document.getElementById('customCoverMorning').checked = !!s.covers_morning;
  document.getElementById('customCoverAfternoon').checked = !!s.covers_afternoon;
  document.getElementById('customCoverEvening').checked = !!s.covers_evening;
  document.getElementById('customIsNight').checked = !!s.is_night;
  document.getElementById('customIsLate').checked = !!s.is_late;
  document.getElementById('customIsLong').checked = !!s.is_long;
  document.getElementById('customIsMidBreak').checked = !!s.is_mid_break;
  openModal('customShiftModal');
};

// 削除
window.deleteCustomShift = async function(id) {
  const s = shiftPatternsCache.find(x => x.id === id);
  if (!s) return;
  if (s.is_default) { showToast('既定シフトは削除できません', 'error'); return; }
  if (!confirm(`カスタムシフト「${s.label || s.id}」を削除しますか？

注意：既にこのシフトを使っている既存のシフト表データには影響しませんが、新規割り当てができなくなります。`)) return;
  showLoading();
  try {
    await sb(`shift_types?id=eq.${encodeURIComponent(id)}`, {method:'DELETE'});
    showToast('削除しました', 'success');
    await loadShiftPatterns();
    await loadShiftTypesAndBuildMaps();
  } catch(e) {
    console.error(e);
    showToast('削除エラー：' + (e.message || ''), 'error');
  }
  hideLoading();
};

// 保存（追加・編集共通）
document.getElementById('saveCustomShiftBtn')?.addEventListener('click', async () => {
  const editId = document.getElementById('customShiftEditId').value;
  const name = document.getElementById('customShiftName').value.trim();
  const start = document.getElementById('customShiftStart').value;
  const end = document.getElementById('customShiftEnd').value;
  const hours = parseFloat(document.getElementById('customShiftHours').value);
  
  // バリデーション
  if (!name) { showToast('シフト名を入力してください', 'error'); return; }
  if (name.length > 10) { showToast('シフト名は10文字以内', 'error'); return; }
  if (!start || !end) { showToast('開始・終了時間を入力してください', 'error'); return; }
  if (isNaN(hours) || hours < 0 || hours > 24) { showToast('実働時間は0〜24Hで入力してください', 'error'); return; }
  
  // 新規追加時の重複チェック
  if (!editId) {
    const exists = shiftPatternsCache.some(s => s.id === name || s.label === name);
    if (exists) { showToast('同じ名前のシフトが既に存在します', 'error'); return; }
  }
  
  const payload = {
    label: name,
    short_label: name,
    start_time: start,
    end_time: end,
    work_hours: hours,
    covers_morning: document.getElementById('customCoverMorning').checked,
    covers_afternoon: document.getElementById('customCoverAfternoon').checked,
    covers_evening: document.getElementById('customCoverEvening').checked,
    is_night: document.getElementById('customIsNight').checked,
    is_late: document.getElementById('customIsLate').checked,
    is_long: document.getElementById('customIsLong').checked,
    is_mid_break: document.getElementById('customIsMidBreak').checked,
    is_off: false,
    is_default: false
  };
  
  showLoading();
  try {
    if (editId) {
      // 更新
      await sb(`shift_types?id=eq.${encodeURIComponent(editId)}`, {method:'PATCH', body: JSON.stringify(payload)});
      showToast('更新しました', 'success');
    } else {
      // 新規追加（idは名前と同じにする）
      payload.id = name;
      // display_orderは既存の最大値+1
      const maxOrder = Math.max(50, ...shiftPatternsCache.filter(s => !s.is_off).map(s => s.display_order || 0));
      payload.display_order = maxOrder + 1;
      await sb('shift_types', {method:'POST', body: JSON.stringify([payload])});
      showToast('追加しました', 'success');
    }
    closeModal('customShiftModal');
    await loadShiftPatterns();
    // 互換マップを再構築（追加されたカスタムシフトを反映）
    await loadShiftTypesAndBuildMaps();
  } catch(e) {
    console.error(e);
    showToast('保存エラー：' + (e.message || ''), 'error');
  }
  hideLoading();
});

async function loadSettings() {
  showLoading();
  // 各処理は個別 try で包み、1つが失敗しても他の処理が止まらないようにする
  const safe = async (label, fn) => {
    try { await fn(); }
    catch(e) { console.error(`[loadSettings] ${label} エラー:`, e); }
  };

  // 必要人数設定（最重要：最初に実行）
  await safe('loadRequirementsGrid', loadRequirementsGrid);

  // 月の所定時間
  await safe('monthlyHours', async () => {
    const hours = await sb(`monthly_hours?year=eq.${currentYear}&dept_id=is.null&order=month&select=month,hours`);
    const hoursMap = {};
    hours.forEach(h => { hoursMap[h.month] = h.hours; });
    let html = '<table class="req-table"><thead><tr>';
    for (let m = 1; m <= 12; m++) html += `<th>${m}月</th>`;
    html += '</tr></thead><tbody><tr>';
    for (let m = 1; m <= 12; m++) {
      html += `<td><input type="number" class="req-input" id="hours-${m}" value="${hoursMap[m] || ''}" step="0.1" min="0" max="250"></td>`;
    }
    html += '</tr></tbody></table>';
    document.getElementById('monthlyHoursGrid').innerHTML = html;
  });

  // 祝日・木曜
  await safe('specialDays', async () => {
    document.getElementById('specialMonthTitle').textContent = `${specialYear}年${specialMonth}月`;
    await renderSpecialDaysGrid();
  });

  // 初心者上限設定
  await safe('beginnerLimits', async () => {
    beginnerLimitsDept = currentDept;
    await loadBeginnerLimits();
  });

  // シフトパターン管理
  await safe('shiftPatterns', loadShiftPatterns);

  // 希望シフト上限
  await safe('reqLimits', async () => {
    reqLimitDept = currentDept;
    await loadReqLimits();
  });

  // 希望提出期限
  await safe('deadline', async () => {
    deadlineDept = currentDept;
    await loadDeadlinePage();
  });

  hideLoading();
}

async function loadRequirementsGrid() {
  const reqs = await sb(`staffing_requirements?dept_id=eq.${currentDept}&select=period_id,day_type,min_count`);
  const reqMap = {};
  reqs.forEach(r => { reqMap[`${r.period_id}-${r.day_type}`] = r.min_count; });

  const periods = [{id:'morning',label:'午前'},{id:'afternoon',label:'午後'},{id:'evening',label:'夜間'}];
  const dayTypes = [
    {id:'weekday',label:'月火金'},
    {id:'wed_normal',label:'水(通常)'},
    {id:'wed_cc',label:'水(CC)'},
    {id:'wed_cho',label:'水(CHO)'},
    {id:'weekend',label:'土日'},
    {id:'thu_open',label:'木(診療)'},
    {id:'holiday_jp',label:'祝日'},
  ];

  let html = '<table class="req-table"><thead><tr><th>時間帯</th>';
  dayTypes.forEach(d => html += `<th>${d.label}</th>`);
  html += '</tr></thead><tbody>';

  periods.forEach(p => {
    html += `<tr><td style="font-weight:600;text-align:left;padding-left:10px">${p.label}</td>`;
    dayTypes.forEach(d => {
      const val = reqMap[`${p.id}-${d.id}`];
      html += `<td><input type="number" class="req-input" id="req-${p.id}-${d.id}" value="${val !== undefined ? val : ''}" min="0" max="50"></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('requirementsGrid').innerHTML = html;
}

// 個別所定時間の一括クリア
document.getElementById('clearStaffHoursBtn')?.addEventListener('click', async () => {
  const deptLabel = DEPT_NAMES[currentDept] || `部署${currentDept}`;
  const monthInput = prompt(
    `${deptLabel} の個別所定時間をクリアする月を入力してください。\n` +
    `（例: 6 と入力すると ${currentYear}年6月分を削除）\n\n` +
    `※ 個別設定を削除すると、そのスタッフは基準値（月間所定労働時間）に統一されます。`,
    String(shiftMonth)
  );
  if (monthInput === null) return;
  const targetMonth = parseInt(monthInput);
  if (isNaN(targetMonth) || targetMonth < 1 || targetMonth > 12) {
    showToast('1〜12 の数字を入力してください', 'error');
    return;
  }

  // 対象スタッフと個別設定の件数を事前確認
  showLoading();
  try {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
    const ids = deptStaff.map(s => `"${s.id}"`).join(',');
    const existing = await sb(`staff_settings?staff_id=in.(${ids})&year=eq.${currentYear}&month=eq.${targetMonth}&select=staff_id,planned_hours`);
    hideLoading();

    if (!existing || existing.length === 0) {
      showToast(`${currentYear}年${targetMonth}月には個別設定がありません`, 'info');
      return;
    }

    if (!confirm(
      `${deptLabel} ${currentYear}年${targetMonth}月の個別所定時間 ${existing.length} 件を削除します。\n\n` +
      `削除後、これらのスタッフは基準値に統一されます。\n` +
      `この操作は取り消せません。続けますか？`
    )) return;

    showLoading();
    await sb(`staff_settings?staff_id=in.(${ids})&year=eq.${currentYear}&month=eq.${targetMonth}`, { method:'DELETE' });
    // シフトキャッシュを無効化 → シフトタブで最新表示
    if (typeof invalidateShiftCache === 'function') invalidateShiftCache();
    showToast(`個別所定時間 ${existing.length} 件を削除しました ✓ シフト表でリロードしてください`, 'success');
  } catch(e) {
    console.error(e);
    showToast('クリアエラー', 'error');
  }
  hideLoading();
});

document.getElementById('saveHoursBtn').addEventListener('click', async () => {
  showLoading();
  try {
    const savedMonths = [];
    for (let m = 1; m <= 12; m++) {
      const val = parseFloat(document.getElementById(`hours-${m}`)?.value);
      if (!isNaN(val)) {
        await sb(`monthly_hours?year=eq.${currentYear}&month=eq.${m}&dept_id=is.null`, { method:'DELETE' });
        await sb('monthly_hours', { method:'POST', body:JSON.stringify([{year:currentYear,month:m,hours:val,dept_id:null}]) });
        savedMonths.push(`${m}月=${val}H`);
      }
    }
    // ★ 診断：実際に保存した内容をログ出力
    console.log(`[saveHours] 保存した内容 (year=${currentYear}):`, savedMonths);
    // 検証クエリ：保存直後に DB から読み直して確認
    const verify = await sb(`monthly_hours?year=eq.${currentYear}&dept_id=is.null&order=month&select=month,hours`);
    console.log(`[saveHours] 保存後の DB の状態:`, verify);

    // ★ シフトキャッシュを無効化 → 次にシフトタブへ移動した時に DB から最新データを読み込む
    if (typeof invalidateShiftCache === 'function') invalidateShiftCache();
    showToast(`所定労働時間を保存しました ✓ (${savedMonths.length}ヶ月分・${currentYear}年)\nシフト表でリロードを押してください`,'success');
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
});

document.getElementById('saveRequirementsBtn').addEventListener('click', async () => {
  showLoading();
  try {
    await sb(`staffing_requirements?dept_id=eq.${currentDept}`, { method:'DELETE' });
    const periods = ['morning','afternoon','evening'];
    const dayTypes = ['weekday','wed_normal','wed_cc','wed_cho','weekend','thu_open','holiday_jp'];
    const inserts = [];
    periods.forEach(p => {
      dayTypes.forEach(d => {
        const el = document.getElementById(`req-${p}-${d}`);
        if (el && el.value !== '') {
          inserts.push({ dept_id:currentDept, period_id:p, day_type:d, min_count:parseInt(el.value) });
        }
      });
    });
    if (inserts.length > 0) {
      await sb('staffing_requirements', { method:'POST', body:JSON.stringify(inserts) });
    }
    // ★ シフトキャッシュを無効化 → 次にシフトタブへ移動した時に DB から最新データを読み込む
    if (typeof invalidateShiftCache === 'function') invalidateShiftCache();
    showToast('必要人数を保存しました ✓ シフト表は次回開いた時に反映されます','success');
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
});

// ===== STAFF =====
// スタッフの並び順を1つ上下に移動
async function moveStaffOrder(staffId, direction) {
  const staff = allStaff.find(s => s.id === staffId);
  if (!staff) return;

  // 同部門のスタッフを並び順でソート
  const deptStaff = allStaff
    .filter(s => s.dept_id === staff.dept_id)
    .sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });

  const idx = deptStaff.findIndex(s => s.id === staffId);
  if (idx < 0) return;

  // 入れ替え対象を特定
  let targetIdx;
  if (direction === 'up') {
    if (idx === 0) return;
    targetIdx = idx - 1;
  } else {
    if (idx === deptStaff.length - 1) return;
    targetIdx = idx + 1;
  }

  const myself = deptStaff[idx];
  const target = deptStaff[targetIdx];

  showLoading();
  try {
    // display_order が NULL の場合は、全員に再採番
    const needsReset = deptStaff.some(s => s.display_order == null);
    if (needsReset) {
      // 部門全員を再採番（10刻み）
      for (let i = 0; i < deptStaff.length; i++) {
        const s = deptStaff[i];
        const newOrder = (i + 1) * 10;
        await sb(`staff?id=eq.${s.id}`, { method:'PATCH', body: JSON.stringify({ display_order: newOrder }) });
        s.display_order = newOrder;
      }
    }

    // 2人を入れ替え
    const myOrder = myself.display_order;
    const targetOrder = target.display_order;
    await sb(`staff?id=eq.${myself.id}`, { method:'PATCH', body: JSON.stringify({ display_order: targetOrder }) });
    await sb(`staff?id=eq.${target.id}`, { method:'PATCH', body: JSON.stringify({ display_order: myOrder }) });

    // ローカル状態を更新
    myself.display_order = targetOrder;
    target.display_order = myOrder;

    // 再描画（loadStaff も呼んでDBから最新を取得）
    await loadStaff();
    loadStaffTable();
  } catch(e) {
    console.error('並び順変更エラー:', e);
    showToast('並び順の変更に失敗しました', 'error');
  }
  hideLoading();
}

async function loadStaffTable() {
  // 権限チェック：master または leader のみアクセス可
  if (!adminUser || (adminUser.role !== 'master' && adminUser.role !== 'leader')) {
    document.getElementById('page-staff').innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626"><div style="font-size:32px;margin-bottom:12px">🔒</div><div style="font-size:14px;font-weight:600">アクセス権限がありません</div></div>';
    return;
  }
  showLoading();
  try {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });
    const ids = deptStaff.map(s => `"${s.id}"`).join(',');
    
    // スタッフ設定を取得（今月分）
    let settingsMap = {};
    if (ids) {
      const settings = await sb(`staff_settings?staff_id=in.(${ids})&year=eq.${currentYear}&month=eq.${currentMonth}&select=*`);
      settings.forEach(s => { settingsMap[s.staff_id] = s; });
    }

    const wrap = document.getElementById('staffListWrap');
    if (!wrap) { hideLoading(); return; }

    const SKILL_LABELS = { normal:'無印', beginner:'🔰', no_count:'🌸' };
    const EMP_LABELS = { full:'常勤', short:'時短', part:'パート' };
    const DOW_LABELS = ['日','月','火','水','木','金','土'];

    wrap.innerHTML = deptStaff.map(staff => {
      const setting = settingsMap[staff.id] || {};
      const planH = setting.planned_hours ?? (
        staff.emp_type === 'full' ? '―（一括）' :
        staff.emp_type === 'short' ? '―（3/4）' : '未設定'
      );
      const fixedShifts = staff.fixed_shifts || {};
      const fixedStr = Object.entries(fixedShifts).map(([dow, shift]) => `${DOW_LABELS[dow]}:${shift}`).join(' ') || '―';

      // 並び順用：このスタッフの前後にあるスタッフを判定
      const sortedDeptStaff = [...deptStaff].sort((a, b) => {
        const aOrder = a.display_order ?? 99999;
        const bOrder = b.display_order ?? 99999;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.staff_code - b.staff_code;
      });
      const myIndex = sortedDeptStaff.findIndex(s => s.id === staff.id);
      const isFirst = myIndex === 0;
      const isLast = myIndex === sortedDeptStaff.length - 1;

      return `
      <div class="staff-row" id="staff-row-${staff.id}" style="border-bottom:1px solid var(--border);padding:16px 20px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <!-- 並び順 ↑↓ -->
          <div style="display:flex;flex-direction:column;gap:2px">
            <button onclick="moveStaffOrder('${staff.id}','up')" ${isFirst ? 'disabled' : ''}
              style="width:28px;height:22px;padding:0;border-radius:6px;font-size:14px;cursor:${isFirst?'not-allowed':'pointer'};
              border:1px solid var(--border);background:${isFirst?'#f3f4f6':'white'};color:${isFirst?'#d1d5db':'#374151'};line-height:1">
              ▲
            </button>
            <button onclick="moveStaffOrder('${staff.id}','down')" ${isLast ? 'disabled' : ''}
              style="width:28px;height:22px;padding:0;border-radius:6px;font-size:14px;cursor:${isLast?'not-allowed':'pointer'};
              border:1px solid var(--border);background:${isLast?'#f3f4f6':'white'};color:${isLast?'#d1d5db':'#374151'};line-height:1">
              ▼
            </button>
          </div>

          <!-- 名前・部門 -->
          <div style="min-width:80px">
            <div style="font-size:15px;font-weight:700">${staff.name}</div>
            <div style="font-size:11px;color:var(--text-muted)">${DEPT_NAMES[staff.dept_id]}</div>
          </div>

          <!-- 能力フラグ -->
          <div style="display:flex;gap:4px">
            ${['normal','beginner','no_count'].map(sk => {
              const currentSkill = staff.skill_level || 'normal';
              const isSelected = currentSkill === sk;
              return `<button onclick="updateStaffField('${staff.id}','skill_level','${sk}')"
                style="padding:4px 10px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;
                border:2px solid ${isSelected?'var(--primary)':'var(--border)'};
                background:${isSelected?'var(--primary)':'white'};
                color:${isSelected?'white':'var(--text-muted)'}">
                ${SKILL_LABELS[sk]}
              </button>`;
            }).join('')}
          </div>

          <!-- 雇用形態 -->
          <div style="display:flex;gap:4px">
            ${['full','short','part'].map(et => `
              <button onclick="updateStaffField('${staff.id}','emp_type','${et}')"
                style="padding:4px 10px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;
                border:1.5px solid ${staff.emp_type===et?'var(--primary)':'var(--border)'};
                background:${staff.emp_type===et?'var(--primary)':'white'};
                color:${staff.emp_type===et?'white':'var(--text-muted)'}">
                ${EMP_LABELS[et]}
              </button>
            `).join('')}
          </div>

          <!-- 夜勤フラグ -->
          <button onclick="toggleStaffNoNight('${staff.id}',${staff.no_night})"
            style="padding:4px 12px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;
            border:1.5px solid ${staff.no_night?'var(--danger)':'var(--border)'};
            background:${staff.no_night?'#fef2f2':'white'};
            color:${staff.no_night?'var(--danger)':'var(--text-muted)'}">
            ${staff.no_night?'夜勤不可':'夜勤可'}
          </button>

          <!-- 招待リンク発行 -->
          <button onclick="generateInviteLink('${staff.id}','${staff.name}')"
            style="padding:4px 10px;border-radius:100px;font-size:12px;cursor:pointer;border:1.5px solid #a855f7;background:white;color:#7c3aed;margin-left:auto;font-weight:600">
            🔗 招待リンク
          </button>

          <!-- 削除 -->
          <button onclick="deleteStaff('${staff.id}','${staff.name}')"
            style="padding:4px 10px;border-radius:100px;font-size:12px;cursor:pointer;border:1.5px solid var(--border);background:white;color:var(--danger)">
            削除
          </button>
        </div>

        <!-- 詳細設定（展開） -->
        <div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">
          
          <!-- 所定労働時間 -->
          <div style="background:var(--bg);border-radius:10px;padding:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">所定労働時間（${currentMonth}月）</div>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="number" id="planH-${staff.id}" value="${setting.planned_hours??''}" placeholder="デフォルト" 
                style="width:80px;padding:6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit"
                step="0.1" min="0" max="300">
              <span style="font-size:12px;color:var(--text-muted)">H</span>
              <button onclick="saveStaffSetting('${staff.id}','planned_hours',document.getElementById('planH-${staff.id}').value)"
                style="padding:4px 10px;background:var(--primary);color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit">保存</button>
            </div>
          </div>

          <!-- 夜勤上限 -->
          <div style="background:var(--bg);border-radius:10px;padding:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">夜勤上限（月）</div>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="number" id="maxNight-${staff.id}" value="${setting.max_night_per_month??''}" placeholder="制限なし"
                style="width:70px;padding:6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit"
                min="0" max="31">
              <span style="font-size:12px;color:var(--text-muted)">回</span>
              <button onclick="saveStaffSetting('${staff.id}','max_night_per_month',document.getElementById('maxNight-${staff.id}').value)"
                style="padding:4px 10px;background:var(--primary);color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit">保存</button>
            </div>
          </div>

          <!-- 遅番上限 -->
          <div style="background:var(--bg);border-radius:10px;padding:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">遅番上限（月）</div>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="number" id="maxLate-${staff.id}" value="${setting.max_late_per_month??''}" placeholder="制限なし"
                style="width:70px;padding:6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit"
                min="0" max="31">
              <span style="font-size:12px;color:var(--text-muted)">回</span>
              <button onclick="saveStaffSetting('${staff.id}','max_late_per_month',document.getElementById('maxLate-${staff.id}').value)"
                style="padding:4px 10px;background:var(--primary);color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit">保存</button>
            </div>
          </div>

          <!-- 長日上限 -->
          <div style="background:var(--bg);border-radius:10px;padding:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">長日上限（月）</div>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="number" id="maxLong-${staff.id}" value="${setting.max_long_per_month??''}" placeholder="制限なし"
                style="width:70px;padding:6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit"
                min="0" max="31">
              <span style="font-size:12px;color:var(--text-muted)">回</span>
              <button onclick="saveStaffSetting('${staff.id}','max_long_per_month',document.getElementById('maxLong-${staff.id}').value)"
                style="padding:4px 10px;background:var(--primary);color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit">保存</button>
            </div>
          </div>

          <!-- 中抜け上限 -->
          <div style="background:var(--bg);border-radius:10px;padding:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">中抜け上限（月）</div>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="number" id="maxMid-${staff.id}" value="${setting.max_mid_per_month??''}" placeholder="制限なし"
                style="width:70px;padding:6px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit"
                min="0" max="31">
              <span style="font-size:12px;color:var(--text-muted)">回</span>
              <button onclick="saveStaffSetting('${staff.id}','max_mid_per_month',document.getElementById('maxMid-${staff.id}').value)"
                style="padding:4px 10px;background:var(--primary);color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit">保存</button>
            </div>
          </div>

          <!-- 曜日固定シフト -->
          <div style="background:var(--bg);border-radius:10px;padding:12px;grid-column:span 2">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;font-weight:600">曜日固定シフト</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end">
              ${[0,1,2,3,4,5,6].map(dow => `
                <div style="text-align:center">
                  <div style="font-size:10px;color:${dow===0||dow===6?'#ef4444':'var(--text-muted)'};margin-bottom:3px">${DOW_LABELS[dow]}</div>
                  <select id="fixedShift-${staff.id}-${dow}"
                    style="width:52px;padding:4px 2px;border:1.5px solid var(--border);border-radius:6px;font-size:10px;font-family:inherit;text-align:center">
                    <option value="">―</option>
                    ${SHIFT_OPTIONS.map(s => `<option value="${s}" ${fixedShifts[dow]===s?'selected':''}>${s}</option>`).join('')}
                  </select>
                </div>
              `).join('')}
              <button onclick="saveAllFixedShifts('${staff.id}')"
                style="padding:6px 14px;background:var(--primary);color:white;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap">
                保存
              </button>
              <button onclick="showClearFixedShiftsModal('${staff.id}','${staff.name}')"
                style="padding:6px 14px;background:white;color:var(--danger);border:1.5px solid var(--danger);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap">
                一括解除
              </button>
            </div>
          </div>

        </div>
      </div>`;
    }).join('');

  } catch(e) { console.error(e); showToast('読み込みエラー','error'); }
  hideLoading();
}

async function updateStaffField(staffId, field, value) {
  showLoading();
  try {
    await sb(`staff?id=eq.${staffId}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ [field]: value })
    });
    // ローカルのallStaffも即時更新
    const idx = allStaff.findIndex(s => s.id === staffId);
    if (idx !== -1) allStaff[idx][field] = value;
    await loadStaffTable();
    showToast('更新しました ✓', 'success');
  } catch(e) { console.error(e); showToast('更新エラー','error'); }
  hideLoading();
}

async function toggleStaffNoNight(staffId, current) {
  await updateStaffField(staffId, 'no_night', !current);
}

async function saveStaffSetting(staffId, field, value) {
  showLoading();
  try {
    const existing = await sb(`staff_settings?staff_id=eq.${staffId}&year=eq.${currentYear}&month=eq.${currentMonth}&select=id`);
    const parsedVal = value === '' ? null : (field === 'planned_hours' ? parseFloat(value) : parseInt(value));
    if (existing.length > 0) {
      await sb(`staff_settings?staff_id=eq.${staffId}&year=eq.${currentYear}&month=eq.${currentMonth}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ [field]: parsedVal })
      });
    } else {
      await sb('staff_settings', {
        method: 'POST',
        body: JSON.stringify([{ staff_id: staffId, year: currentYear, month: currentMonth, [field]: parsedVal }])
      });
    }
    showToast('保存しました ✓', 'success');
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
}

async function saveAllFixedShifts(staffId) {
  showLoading();
  try {
    const fixedShifts = {};
    [0,1,2,3,4,5,6].forEach(dow => {
      const el = document.getElementById(`fixedShift-${staffId}-${dow}`);
      if (el && el.value !== '') fixedShifts[dow] = el.value;
    });
    await sb(`staff?id=eq.${staffId}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ fixed_shifts: fixedShifts })
    });
    const idx = allStaff.findIndex(s => s.id === staffId);
    if (idx !== -1) allStaff[idx].fixed_shifts = fixedShifts;
    showToast('曜日固定シフトを保存しました ✓', 'success');

    // シフト表への反映確認
    const staffName = allStaff.find(s => s.id === staffId)?.name || '';
    if (Object.keys(fixedShifts).length > 0) {
      showFixedShiftApplyModal(staffId, staffName, fixedShifts);
    }
  } catch(e) { console.error(e); showToast('保存エラー','error'); }
  hideLoading();
}


function showClearFixedShiftsModal(staffId, staffName) {
  // 現状の曜日固定設定を取得して表示
  const staff = allStaff.find(s => s.id === staffId);
  const currentFixed = staff?.fixed_shifts || {};
  const fixedEntries = Object.entries(currentFixed);

  if (fixedEntries.length === 0) {
    showToast('曜日固定シフトが設定されていません', 'error');
    return;
  }

  document.getElementById('clearFixedModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'clearFixedModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)';

  const DOW_LABELS_LOCAL = ['日','月','火','水','木','金','土'];
  const months = Array.from({length:12},(_,i)=>i+1);
  const fixedDesc = fixedEntries.map(([dow, shift]) => `${DOW_LABELS_LOCAL[dow]}曜:${shift}`).join(' / ');

  modal.innerHTML = `
    <div style="background:white;border-radius:20px;padding:28px;width:100%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,0.2)">
      <div style="font-size:18px;font-weight:700;margin-bottom:6px">${staffName}の繰り返しシフトを解除</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">指定した月以降、設定された曜日固定のシフトのみを削除します</div>

      <div style="background:#f0f9ff;border-radius:10px;padding:12px;margin-bottom:16px;font-size:13px;color:#0c4a6e">
        <div style="font-weight:600;margin-bottom:4px">削除対象の曜日・シフト</div>
        <div>${fixedDesc}</div>
      </div>

      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;font-weight:600">削除開始月（この月以降を削除）</div>
      <div style="display:flex;gap:12px;margin-bottom:16px">
        <select id="clearStartYear" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
          <option value="${currentYear}">${currentYear}年</option>
          <option value="${currentYear+1}">${currentYear+1}年</option>
        </select>
        <select id="clearStartMonth" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
          ${months.map(m => `<option value="${m}" ${m===currentMonth?'selected':''}>${m}月</option>`).join('')}
        </select>
      </div>

      <div style="background:#fef3c7;border-radius:10px;padding:12px;margin-bottom:20px;font-size:13px;color:#92400e;line-height:1.6">
        ⚠️ 上記の曜日 × シフトに完全一致するもの<strong>のみ</strong>削除します<br>
        ⚠️ ロックされていても削除します<br>
        ⚠️ 他の曜日や別のシフトには影響しません<br>
        ⚠️ 曜日固定シフトの設定もクリアされます
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button onclick="document.getElementById('clearFixedModal').remove()"
          style="padding:10px 18px;border:1.5px solid var(--border);border-radius:10px;background:white;cursor:pointer;font-family:inherit">キャンセル</button>
        <button onclick="clearFixedShifts('${staffId}','${staffName}')"
          style="padding:10px 18px;background:var(--danger);color:white;border:none;border-radius:10px;font-weight:600;cursor:pointer;font-family:inherit">解除する</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function clearFixedShifts(staffId, staffName) {
  const startYear = parseInt(document.getElementById('clearStartYear').value);
  const startMonth = parseInt(document.getElementById('clearStartMonth').value);
  document.getElementById('clearFixedModal')?.remove();

  // 現状の曜日固定設定を取得
  const staff = allStaff.find(s => s.id === staffId);
  const fixedShifts = staff?.fixed_shifts || {};
  const fixedEntries = Object.entries(fixedShifts);
  if (fixedEntries.length === 0) {
    showToast('曜日固定シフトが設定されていません', 'info');
    return;
  }

  if (!confirm(`${staffName}の${startYear}年${startMonth}月以降の「曜日固定で設定された曜日 × シフト」を削除します。よろしいですか？`)) {
    return;
  }

  // ★ 確定ロックチェック：操作範囲内に確定済み月があれば中止
  const maxFutureYearCheck = startYear + 2;
  if (!(await checkRangeNotConfirmed(currentDept, startYear, startMonth, maxFutureYearCheck, 12))) {
    return;
  }

  showLoading();
  try {
    // 削除対象の最終月を決定: 既存shiftsの最大年月を取得し、そこまでループ
    // 念のため未来側は12ヶ月先まで見る
    const maxFutureYear = startYear + 2; // 安全側に2年先まで

    let deletedTotal = 0;

    // 開始年月から maxFutureYear の12月まで月単位でループ
    let curYear = startYear;
    let curMonth = startMonth;
    while (curYear <= maxFutureYear) {
      const daysInMonth = new Date(curYear, curMonth, 0).getDate();

      // 各曜日の対象日を集める
      const deletions = []; // { day, shift_type_id }
      for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(curYear, curMonth-1, d).getDay();
        const fixedShift = fixedShifts[dow];
        if (!fixedShift) continue;
        deletions.push({ day: d, shift_type_id: fixedShift });
      }

      // 削除実行: day と shift_type_id が完全一致するもののみ
      for (const del of deletions) {
        const url = `shifts?staff_id=eq.${staffId}&year=eq.${curYear}&month=eq.${curMonth}&day=eq.${del.day}&shift_type_id=eq.${encodeURIComponent(del.shift_type_id)}`;
        const before = await sb(`${url}&select=id`);
        if (before && before.length > 0) {
          await sb(url, { method: 'DELETE' });
          deletedTotal += before.length;
        }
      }

      // 表示中の月ならローカルもクリア
      if (curYear === shiftYear && curMonth === shiftMonth) {
        deletions.forEach(del => {
          const key = `${staffId}|${del.day}`;
          if (shiftData[key] === del.shift_type_id) {
            delete shiftData[key];
            delete lockedCells[key];
          }
        });
        // ★ ロールバック: rerenderShiftGridFromMemory ではなく DB から再取得
        await loadShiftGrid();
      }

      curMonth++;
      if (curMonth > 12) { curMonth = 1; curYear++; }
    }

    // fixed_shifts設定をクリア
    await sb(`staff?id=eq.${staffId}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ fixed_shifts: {} })
    });

    const idx = allStaff.findIndex(s => s.id === staffId);
    if (idx !== -1) allStaff[idx].fixed_shifts = {};

    await loadStaffTable();

    showToast(`${staffName}の曜日固定を解除しました（${deletedTotal}日分削除） ✓`, 'success');
  } catch(e) { console.error(e); showToast('解除エラー：' + (e.message||''), 'error'); }
  hideLoading();
}

function showFixedShiftApplyModal(staffId, staffName, fixedShifts) {
  // 既存モーダルを削除
  document.getElementById('fixedShiftApplyModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'fixedShiftApplyModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)';

  const months = [];
  for (let m = 1; m <= 12; m++) months.push(m);

  // 終了月のデフォルトは開始月+6ヶ月後
  let defEndYear = currentYear;
  let defEndMonth = currentMonth + 6;
  if (defEndMonth > 12) { defEndMonth -= 12; defEndYear++; }

  modal.innerHTML = `
    <div style="background:white;border-radius:20px;padding:28px;width:100%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,0.2)">
      <div style="font-size:18px;font-weight:700;margin-bottom:6px">${staffName}の曜日固定を反映</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px">シフト表に反映する期間を選択してください</div>

      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;font-weight:600">開始</div>
      <div style="display:flex;gap:12px;margin-bottom:16px">
        <select id="fixedApplyStartYear" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
          <option value="${currentYear}">${currentYear}年</option>
          <option value="${currentYear+1}">${currentYear+1}年</option>
        </select>
        <select id="fixedApplyStartMonth" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
          ${months.map(m => `<option value="${m}" ${m===currentMonth?'selected':''}>${m}月</option>`).join('')}
        </select>
      </div>

      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;font-weight:600">終了</div>
      <div style="display:flex;gap:12px;margin-bottom:16px">
        <select id="fixedApplyEndYear" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
          <option value="${currentYear}" ${defEndYear===currentYear?'selected':''}>${currentYear}年</option>
          <option value="${currentYear+1}" ${defEndYear===currentYear+1?'selected':''}>${currentYear+1}年</option>
        </select>
        <select id="fixedApplyEndMonth" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
          ${months.map(m => `<option value="${m}" ${m===defEndMonth?'selected':''}>${m}月</option>`).join('')}
        </select>
      </div>

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;padding:12px;background:#fef3c7;border-radius:10px">
        <input type="checkbox" id="fixedApplyLock" checked style="width:16px;height:16px;cursor:pointer">
        <label for="fixedApplyLock" style="font-size:13px;cursor:pointer">反映後にロック（手動変更可）</label>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button onclick="document.getElementById('fixedShiftApplyModal').remove()"
          style="padding:10px 18px;border:1.5px solid var(--border);border-radius:10px;background:white;cursor:pointer;font-family:inherit">キャンセル</button>
        <button onclick="applyFixedShiftsToGrid('${staffId}',${JSON.stringify(fixedShifts).replace(/"/g,"'")})"
          style="padding:10px 18px;background:var(--primary);color:white;border:none;border-radius:10px;font-weight:600;cursor:pointer;font-family:inherit">反映する</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function applyFixedShiftsToGrid(staffId, fixedShifts) {
  const startYear = parseInt(document.getElementById('fixedApplyStartYear').value);
  const startMonth = parseInt(document.getElementById('fixedApplyStartMonth').value);
  const endYear = parseInt(document.getElementById('fixedApplyEndYear').value);
  const endMonth = parseInt(document.getElementById('fixedApplyEndMonth').value);
  const withLock = document.getElementById('fixedApplyLock').checked;
  document.getElementById('fixedShiftApplyModal')?.remove();

  // 期間の妥当性チェック
  const startKey = startYear * 12 + startMonth;
  const endKey = endYear * 12 + endMonth;
  if (endKey < startKey) {
    showToast('終了月は開始月以降にしてください', 'error');
    return;
  }
  // 12ヶ月以上は警告（安全のため）
  if (endKey - startKey > 24) {
    if (!confirm(`${endKey - startKey + 1}ヶ月分という長期間です。続行しますか？`)) return;
  }

  // ★ 確定ロックチェック：操作範囲内に確定済み月があれば中止
  if (!(await checkRangeNotConfirmed(currentDept, startYear, startMonth, endYear, endMonth))) {
    return;
  }

  showLoading();
  try {
    let totalInserts = 0;
    let monthCount = 0;

    // 開始年月から終了年月まで月単位でループ
    let curYear = startYear;
    let curMonth = startMonth;
    while (curYear * 12 + curMonth <= endKey) {
      const daysInMonth = new Date(curYear, curMonth, 0).getDate();
      const inserts = [];

      // 既存シフトを取得
      const existing = await sb(`shifts?staff_id=eq.${staffId}&year=eq.${curYear}&month=eq.${curMonth}&select=day,shift_type_id,is_locked`);
      const existingMap = {};
      existing.forEach(s => { existingMap[s.day] = s; });

      for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(curYear, curMonth-1, d).getDay();
        const fixedShift = fixedShifts[dow];
        if (!fixedShift) continue;
        // ロック済みはスキップ（上書きしない）
        if (existingMap[d]?.is_locked) continue;
        inserts.push({
          staff_id: staffId,
          year: curYear,
          month: curMonth,
          day: d,
          shift_type_id: fixedShift,
          is_locked: withLock,
          lock_type: withLock ? 'fixed_shift' : null,
        });
      }

      if (inserts.length > 0) {
        // 対象日のロックされてないシフトを削除してから挿入
        for (const ins of inserts) {
          await sb(`shifts?staff_id=eq.${staffId}&year=eq.${curYear}&month=eq.${curMonth}&day=eq.${ins.day}&is_locked=eq.false`, {method:'DELETE'});
        }
        await sb('shifts', {method:'POST', body:JSON.stringify(inserts)});
        totalInserts += inserts.length;
      }

      // 表示中の月ならローカルにも反映
      if (curYear === shiftYear && curMonth === shiftMonth) {
        inserts.forEach(ins => {
          const key = `${staffId}|${ins.day}`;
          shiftData[key] = ins.shift_type_id;
          if (withLock) lockedCells[key] = true;
        });
        // ★ ロールバック: rerenderShiftGridFromMemory ではなく DB から再取得
        await loadShiftGrid();
      }

      monthCount++;
      curMonth++;
      if (curMonth > 12) { curMonth = 1; curYear++; }
    }

    showToast(`${monthCount}ヶ月分・合計${totalInserts}日の固定シフトを反映しました ✓`, 'success');
  } catch(e) { console.error(e); showToast('反映エラー：' + (e.message||''), 'error'); }
  hideLoading();
}

document.getElementById('addAccountBtn')?.addEventListener('click', () => showAddAccountModal());

// =====================================================
// 招待リンク機能
// =====================================================
async function generateInviteLink(staffId, staffName) {
  // モーダル表示
  document.getElementById('inviteGenerating').style.display = 'block';
  document.getElementById('inviteResult').style.display = 'none';
  document.getElementById('inviteError').style.display = 'none';
  document.getElementById('inviteLinkModal').style.display = 'flex';

  try {
    // 既に有効な招待がある場合は無効化（取り消し）
    await sb(`invitations?staff_id=eq.${staffId}&used_at=is.null`, {
      method: 'DELETE'
    }).catch(() => {});  // 失敗してもOK

    // ランダムトークン生成（256bit相当）
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    // 7日間有効
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // DBに登録
    const result = await sb('invitations', {
      method: 'POST',
      body: JSON.stringify([{
        token,
        staff_id: staffId,
        invited_by: adminUser?.id || null,
        expires_at: expiresAt
      }])
    });

    // URL生成
    const baseUrl = window.location.origin;
    const inviteUrl = `${baseUrl}/invite.html?token=${token}`;

    // 表示
    document.getElementById('inviteTargetName').textContent = staffName + ' さん';
    const expDate = new Date(expiresAt);
    document.getElementById('inviteExpiresAt').textContent = `有効期限: ${expDate.getMonth()+1}月${expDate.getDate()}日 ${String(expDate.getHours()).padStart(2,'0')}:${String(expDate.getMinutes()).padStart(2,'0')}まで`;
    document.getElementById('inviteUrlText').value = inviteUrl;

    document.getElementById('inviteGenerating').style.display = 'none';
    document.getElementById('inviteResult').style.display = 'block';

    // 入力リセット用にデータ保持
    document.getElementById('inviteResult').dataset.staffName = staffName;
    document.getElementById('inviteResult').dataset.url = inviteUrl;
  } catch(e) {
    console.error('招待リンク生成エラー:', e);
    document.getElementById('inviteGenerating').style.display = 'none';
    document.getElementById('inviteError').style.display = 'block';
    document.getElementById('inviteErrorText').textContent = '招待リンクの生成に失敗しました: ' + (e.message || '');
  }
}

document.getElementById('closeInviteModal')?.addEventListener('click', () => {
  document.getElementById('inviteLinkModal').style.display = 'none';
});

document.getElementById('inviteCopyBtn')?.addEventListener('click', () => {
  const url = document.getElementById('inviteUrlText').value;
  navigator.clipboard.writeText(url).then(() => {
    showToast('招待リンクをコピーしました ✓', 'success');
  }).catch(() => {
    showToast('コピーに失敗しました', 'error');
  });
});

document.getElementById('inviteCopyMessageBtn')?.addEventListener('click', () => {
  const url = document.getElementById('inviteResult').dataset.url;
  const name = document.getElementById('inviteResult').dataset.staffName;
  const msg = `${name}さん

kingyo-shift（シフト管理アプリ）のアカウント作成のご案内です。
以下のリンクから、メールアドレスとパスワードを設定してアカウントを作成してください。

${url}

※リンクは7日間有効です。
※質問があればお気軽にどうぞ。`;
  navigator.clipboard.writeText(msg).then(() => {
    showToast('メッセージをコピーしました ✓', 'success');
  }).catch(() => {
    showToast('コピーに失敗しました', 'error');
  });
});

document.getElementById('addStaffBtn').addEventListener('click', () => {
  document.getElementById('addStaffModal').classList.add('show');
});

// アカウント作成チェックボックスの切り替えで欄の表示/非表示
document.getElementById('newStaffCreateAccount')?.addEventListener('change', (e) => {
  document.getElementById('newStaffAccountFields').style.display = e.target.checked ? 'block' : 'none';
});

document.getElementById('saveNewStaffBtn').addEventListener('click', async () => {
  const deptId = parseInt(document.getElementById('newStaffDept').value);
  const name = document.getElementById('newStaffName').value.trim();
  const empType = document.getElementById('newStaffEmpType').value;
  const noNight = document.getElementById('newStaffNoNight').value === 'true';
  const createAccount = document.getElementById('newStaffCreateAccount').checked;
  const password = document.getElementById('newStaffPassword').value;

  if (!name) { showToast('名前を入力してください','error'); return; }

  if (createAccount) {
    if (!password) { showToast('初期パスワードを入力してください','error'); return; }
    if (password.length < 4) { showToast('パスワードは4文字以上にしてください','error'); return; }
  }

  showLoading();
  try {
    // 1. staff テーブルに登録（レスポンスから新規ID取得）
    const maxCode = allStaff.filter(s => s.dept_id === deptId).reduce((m, s) => Math.max(m, s.staff_code), 0);
    const newStaffCode = maxCode + 1;
    const staffResp = await sb('staff', { method:'POST', body:JSON.stringify([{staff_code:newStaffCode,name,dept_id:deptId,emp_type:empType,no_night:noNight,no_count:false}]) });
    const newStaff = Array.isArray(staffResp) ? staffResp[0] : staffResp;
    if (!newStaff || newStaff.id == null) {
      throw new Error('スタッフ登録のレスポンスからIDを取得できませんでした');
    }

    // 2. accounts テーブルにも登録（チェックON時のみ） - API経由
    if (createAccount) {
      try {
        await adminApi('/api/admin-accounts', {
          action: 'create-for-new-staff',
          name, password,
          deptId, staffId: newStaff.id, staffCode: newStaffCode,
        });
      } catch(accErr) {
        console.error('アカウント作成エラー:', accErr);
        const msg = `${name}を追加しましたが、アカウント作成に失敗しました（${accErr.message || ''}）`;
        showToast(msg, 'error');
        await loadStaff();
        loadStaffTable();
        closeModal('addStaffModal');
        document.getElementById('newStaffName').value = '';
        document.getElementById('newStaffPassword').value = '';
        hideLoading();
        return;
      }
    }

    await loadStaff();
    loadStaffTable();
    closeModal('addStaffModal');
    // 入力リセット
    document.getElementById('newStaffName').value = '';
    document.getElementById('newStaffPassword').value = '';
    const msg = createAccount ? `${name} を追加しました（アカウントも作成 ✓）` : `${name} を追加しました ✓`;
    showToast(msg, 'success');
  } catch(e) {
    console.error(e);
    showToast('追加エラー：' + (e.message || ''), 'error');
  }
  hideLoading();
});

async function deleteStaff(id, name) {
  if (!confirm(`${name} を削除しますか？`)) return;
  showLoading();
  try {
    await sb(`staff?id=eq.${id}`, { method:'DELETE' });
    await loadStaff();
    loadStaffTable();
    showToast(`${name} を削除しました`,'success');
  } catch(e) { showToast('削除エラー','error'); }
  hideLoading();
}


// ===== CSV出力 =====
document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
  const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
  const daysInMonth = new Date(shiftYear, shiftMonth, 0).getDate();
  const DOW_JP = ['日','月','火','水','木','金','土'];

  // ヘッダー行
  let csv = '名前,雇用形態';
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(shiftYear, shiftMonth-1, d).getDay();
    csv += `,${d}(${DOW_JP[dow]})`;
  }
  csv += ',実働時間,所定時間\n';

  // スタッフ行
  deptStaff.forEach(staff => {
    const empLabel = staff.emp_type === 'full' ? '常勤' : staff.emp_type === 'short' ? '時短' : 'パート';
    let totalH = 0;
    let row = `${staff.name},${empLabel}`;
    const csvHolidays = getJapaneseHolidays(shiftYear, shiftMonth);
    for (let d = 1; d <= daysInMonth; d++) {
      const shift = shiftData[`${staff.id}|${d}`] || '';
      totalH += SHIFT_HOURS[shift] || 0;
      if (PAID_LEAVE_SHIFTS.includes(shift)) {
        const dt = new Date(shiftYear, shiftMonth - 1, d);
        totalH += getYukyuHours(dt.getDay(), csvHolidays.has(d));
      }
      if (shift === '半有休') totalH += 5;
      row += `,${shift}`;
    }
    const setting = shiftGridStaffSettings[staff.id];
    const planH = setting?.planned_hours ?? (
      staff.emp_type === 'full' ? shiftGridPlanHours :
      staff.emp_type === 'short' ? Math.round(shiftGridPlanHours * APP_SHORT_RATIO * 10)/10 : 0
    );
    row += `,${Math.round(totalH*10)/10},${planH}`;
    csv += row + '\n';
  });

  // 充足状況行
  csv += '\n午前充足';
  for (let d = 1; d <= daysInMonth; d++) {
    const req = shiftGridRequirements['morning']?.[getShiftDayTypeForExport(d)] ?? null;
    const covered = deptStaff.filter(s => {
      if (s.skill_level === 'no_count' || s.no_count === true) return false;
      const shift = shiftData[`${s.id}|${d}`];
      return shift && SHIFT_COVERS[shift]?.includes('morning');
    }).length;
    csv += req !== null ? `,${covered}/${req}` : ',―';
  }
  csv += '\n午後充足';
  for (let d = 1; d <= daysInMonth; d++) {
    const req = shiftGridRequirements['afternoon']?.[getShiftDayTypeForExport(d)] ?? null;
    const covered = deptStaff.filter(s => {
      if (s.skill_level === 'no_count' || s.no_count === true) return false;
      const shift = shiftData[`${s.id}|${d}`];
      return shift && SHIFT_COVERS[shift]?.includes('afternoon');
    }).length;
    csv += req !== null ? `,${covered}/${req}` : ',―';
  }
  csv += '\n夜間充足';
  for (let d = 1; d <= daysInMonth; d++) {
    const req = shiftGridRequirements['evening']?.[getShiftDayTypeForExport(d)] ?? null;
    const covered = deptStaff.filter(s => {
      if (s.skill_level === 'no_count' || s.no_count === true) return false;
      const shift = shiftData[`${s.id}|${d}`];
      return shift && SHIFT_COVERS[shift]?.includes('evening');
    }).length;
    csv += req !== null ? `,${covered}/${req}` : ',―';
  }
  csv += '\n';

  // ===== シフトパターン凡例（このシフト表で使われているシフトを集計）=====
  csv += '\n【シフトパターン凡例】\n';
  csv += 'シフト名,時間,実働,午前カバー,午後カバー,夜間カバー,分類,使用回数\n';
  
  // このシフト表で使用されているシフトをカウント
  const usedShiftCount = {};
  deptStaff.forEach(staff => {
    for (let d = 1; d <= daysInMonth; d++) {
      const sh = shiftData[`${staff.id}|${d}`];
      if (sh) usedShiftCount[sh] = (usedShiftCount[sh] || 0) + 1;
    }
  });
  
  // shift_typesから情報を取得して凡例を出力（display_order順）
  shiftTypesAll.forEach(s => {
    const count = usedShiftCount[s.id] || 0;
    if (count === 0) return; // 使われていないシフトは省略
    const time = (s.start_time && s.end_time) ? `${s.start_time}-${s.end_time}` : '';
    const hours = s.work_hours ? `${parseFloat(s.work_hours)}H` : '';
    const m = s.covers_morning ? '○' : '−';
    const a = s.covers_afternoon ? '○' : '−';
    const e = s.covers_evening ? '○' : '−';
    // 分類タグ
    const tags = [];
    if (s.is_off) tags.push('休み');
    if (s.is_night) tags.push('夜勤');
    if (s.is_late) tags.push('遅番');
    if (s.is_long) tags.push('長日');
    if (s.is_mid_break) tags.push('中抜け');
    if (!s.is_default) tags.push('カスタム');
    const tagStr = tags.length > 0 ? tags.join('・') : '通常';
    csv += `${s.id},${time},${hours},${m},${a},${e},${tagStr},${count}\n`;
  });

  // BOM付きUTF-8でダウンロード
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `シフト表_${DEPT_NAMES[currentDept]}_${shiftYear}年${shiftMonth}月.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSVを出力しました ✓', 'success');
});

function getShiftDayTypeForExport(d) {
  const holidays = getJapaneseHolidays(shiftYear, shiftMonth);
  const dow = new Date(shiftYear, shiftMonth-1, d).getDay();
  if (holidays.has(d)) return 'holiday_jp';
  if (dow === 0 || dow === 6) return 'weekend';
  if (dow === 3) return wedTypes[d] === 'cc' ? 'wed_cc' : wedTypes[d] === 'cho' ? 'wed_cho' : 'wed_normal';
  if (dow === 4) return 'thu_open';
  return 'weekday';
}

// ===== シフト表リロード機能 =====
// DB から最新データを再読み込みする（設定変更後など、外部要因で DB が更新された時用）
async function reloadShiftGrid() {
  // 未保存変更があれば確認
  if (savedShiftSnapshot) {
    const hasUnsaved = JSON.stringify(shiftData) !== JSON.stringify(savedShiftSnapshot.shiftData)
                    || JSON.stringify(lockedCells) !== JSON.stringify(savedShiftSnapshot.lockedCells);
    if (hasUnsaved && !confirm('未保存の変更があります。\nリロードすると変更が失われます。続けますか？')) {
      return;
    }
  }
  // キャッシュも無効化して、確実に DB から再取得する
  invalidateShiftCache();
  showLoading();
  try {
    // ★ 診断：DB の monthly_hours を直接確認してログ出力
    const rawHours = await sb(`monthly_hours?year=eq.${shiftYear}&month=eq.${shiftMonth}&dept_id=is.null&select=hours`);
    console.log(`[reload] DB の monthly_hours (year=${shiftYear}, month=${shiftMonth}, dept_id=NULL):`, rawHours);

    await loadShiftGrid();
    console.log(`[reload] loadShiftGrid 後の shiftGridPlanHours:`, shiftGridPlanHours);

    showToast(`シフト表を最新化 ✓ ${shiftYear}年${shiftMonth}月の所定: ${shiftGridPlanHours}H`, 'success');
  } catch(e) {
    console.error(e);
    showToast('リロードエラー', 'error');
  }
  hideLoading();
}

// シフト関連のメモリキャッシュを無効化
// 設定画面で所定労働時間・必要人数などを変更した後に呼ぶことで、
// シフトタブに戻った時に DB から最新データが読み込まれる。
function invalidateShiftCache() {
  shiftMonthCache = {};
  shiftGridContext = null;
}

// 希望（スタッフ提出シフト希望）だけを再取得して上書き表示する。
// 未保存のシフト編集（shiftData / lockedCells）は保持したまま、希望オーバーレイのみ最新化する。
async function reloadRequestsOnly() {
  showLoading();
  try {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept);
    const ids = deptStaff.map(s => s.id);
    const reqMap = {};
    if (ids.length > 0) {
      const reqs = await sb(`shift_requests?staff_id=in.(${ids})&year=eq.${shiftYear}&month=eq.${shiftMonth}&select=staff_id,day,request_type`);
      reqs.forEach(r => { reqMap[`${r.staff_id}|${r.day}`] = r.request_type; });
    }
    window._shiftReqMap = reqMap;
    rerenderShiftGridFromMemory();
    showToast('希望を最新化しました ✓', 'success');
  } catch (e) {
    console.error(e);
    showToast('希望のリロードに失敗しました', 'error');
  }
  hideLoading();
}
document.getElementById('reloadShiftBtn')?.addEventListener('click', reloadRequestsOnly);

// エクスポートページ：印刷対象のシフト表DOMを表示状態にする（@media print はシフト表DOMに依存するため）
function activateShiftPageForOutput() {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const shiftNav = document.querySelector('.nav-item[data-page="shift"]');
  if (shiftNav) shiftNav.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const shiftPage = document.getElementById('page-shift');
  if (shiftPage) shiftPage.classList.add('active');
  const t = document.getElementById('topbarTitle');
  if (t) t.textContent = 'シフト表';
}

// エクスポートページ：出力対象（シフト表で選択中の部署・月）をグリッドに用意し、ラベルを更新
async function loadExportPage() {
  const ctx = `${currentDept}|${shiftYear}|${shiftMonth}`;
  // 既に同コンテキストが読み込まれている場合は未保存編集を消さないため再読込しない
  if (shiftGridContext !== ctx) {
    await loadShiftGrid();
  }
  const label = document.getElementById('exportContextLabel');
  if (label) label.textContent = `${DEPT_NAMES[currentDept] || ''}　${shiftYear}年${shiftMonth}月`;
}

// ===== 印刷 =====
document.getElementById('printShiftBtn')?.addEventListener('click', () => {
  // ★ 念のためバーチカル印刷状態を解除（クラスが残っていてもシフト表印刷を誤らせない保険）
  document.body.classList.remove('printing-vertical');
  // エクスポートページから押された場合でも、印刷対象のシフト表を表示状態にしてから印刷する
  activateShiftPageForOutput();
  // 印刷ヘッダーを表示
  const header = document.getElementById('print-header');
  const sub = document.getElementById('printHeaderSub');
  if (header && sub) {
    header.style.display = 'block';
    sub.textContent = `${DEPT_NAMES[currentDept]}　${shiftYear}年${shiftMonth}月`;
  }
  // ★ ヘッダー除去も afterprint で（プレビュー操作中に消えるのを防ぐ）
  const cleanup = () => {
    if (header) header.style.display = 'none';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // ★ DOM 更新後にレンダリングが完了してから print() を呼ぶ。
  //   即座に呼ぶと印刷プレビューが空白になることがある。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
    });
  });
});

// MONTH NAV
document.getElementById('reqPrevMonth').addEventListener('click', async () => { reqMonth--; if(reqMonth<1){reqMonth=12;reqYear--;} updateMonthDisplays(); await loadRequests(); });
document.getElementById('reqNextMonth').addEventListener('click', async () => { reqMonth++; if(reqMonth>12){reqMonth=1;reqYear++;} updateMonthDisplays(); await loadRequests(); });
document.getElementById('shiftPrevMonth').addEventListener('click', async () => { saveCurrentShiftStateToCache(); shiftMonth--; if(shiftMonth<1){shiftMonth=12;shiftYear--;} updateMonthDisplays(); const newCtx = `${currentDept}|${shiftYear}|${shiftMonth}`; if (tryRestoreShiftStateFromCache(newCtx)) rerenderShiftGridFromMemory(); else await loadShiftGrid(); });
document.getElementById('shiftNextMonth').addEventListener('click', async () => { saveCurrentShiftStateToCache(); shiftMonth++; if(shiftMonth>12){shiftMonth=1;shiftYear++;} updateMonthDisplays(); const newCtx = `${currentDept}|${shiftYear}|${shiftMonth}`; if (tryRestoreShiftStateFromCache(newCtx)) rerenderShiftGridFromMemory(); else await loadShiftGrid(); });
document.getElementById('genPrevMonth').addEventListener('click', async () => { genMonth--; if(genMonth<1){genMonth=12;genYear--;} updateMonthDisplays(); await loadGenPage(); });
document.getElementById('genNextMonth').addEventListener('click', async () => { genMonth++; if(genMonth>12){genMonth=1;genYear++;} updateMonthDisplays(); await loadGenPage(); });
document.getElementById('dashPrevMonth')?.addEventListener('click', async () => { dashMonth--; if(dashMonth<1){dashMonth=12;dashYear--;} updateMonthDisplays(); await loadDashboard(); });
document.getElementById('dashNextMonth')?.addEventListener('click', async () => { dashMonth++; if(dashMonth>12){dashMonth=1;dashYear++;} updateMonthDisplays(); await loadDashboard(); });

// LOGOUT
document.getElementById('adminLogoutBtn').addEventListener('click', () => {
  adminUser = null;
  localStorage.removeItem('shift_admin_token');
  document.getElementById('appScreen').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('adminDeptSelect').value = '';
  document.getElementById('adminNameSelect').innerHTML = '<option value="">先に部門を選択してください</option>';
  document.getElementById('adminNameSelect').disabled = true;
  document.getElementById('adminPassword').value = '';
});

// モーダル外クリックで閉じる
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if(e.target===overlay) overlay.classList.remove('show'); });
});

// ===== PWA Service Worker & スクロール制御 =====
// PWA Service Worker 登録
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW登録失敗:', err));
  });
}

// PWA起動時の不要なスクロール・キーボード起動を防止
(function() {
  // 初回起動時のみスクロールリセット
  window.addEventListener('DOMContentLoaded', () => {
    window.scrollTo(0, 0);
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  });
  // load時も初回のみ
  let _initialScrollDone = false;
  window.addEventListener('load', () => {
    if (_initialScrollDone) return;
    _initialScrollDone = true;
    setTimeout(() => {
      window.scrollTo(0, 0);
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    }, 100);
  });
  // 入力欄から外れた時のみ：ボタンクリック時の暴走を防ぐ
  document.addEventListener('focusout', (e) => {
    const target = e.target;
    if (!target || !target.tagName) return;
    const tag = target.tagName.toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
    setTimeout(() => {
      const newFocus = document.activeElement;
      if (newFocus && (newFocus.tagName === 'INPUT' || newFocus.tagName === 'TEXTAREA' || newFocus.tagName === 'SELECT')) {
        return;
      }
      // ボタンクリック等でフォーカスが外れたケース：スクロールはそのまま
    }, 100);
  });
})();
