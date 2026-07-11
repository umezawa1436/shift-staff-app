// =====================================================
// admin-generate.js : シフト自動生成ロジック
//   依存：admin.js を先に読み込むこと（グローバル変数・共通関数・
//        SHIFT_PATTERN_OPTIONS・getJapaneseHolidays を使用）
// =====================================================

// ===== AUTO GENERATE =====

// ===== シフトパターン設定 =====

// デフォルトのシフトパターン設定
const DEFAULT_SHIFT_PATTERNS = {
  0: ['日勤','日勤+','午前','午後','遅番','遅L','夜勤','長日','時短'],     // 医療事務
  1: ['日勤','日勤+','遅番','遅L','夜勤','長日','時短'],                    // 看護
  2: ['日勤','日勤+','リハ遅','夜勤','長日','時短'],                        // リハビリ
  3: ['日勤','日勤+','午前','遅番','遅L','夜勤','時短'],                    // 放射線
};

let shiftPatternSettings = {}; // 部門ごとの設定（DBキャッシュ）

async function loadShiftPatternSettings() {
  // DBから部署ごとのシフトパターン設定を読み込み
  try {
    const rows = await sb('dept_shift_pattern_settings?select=dept_id,enabled_patterns');
    shiftPatternSettings = {};
    rows.forEach(r => {
      shiftPatternSettings[r.dept_id] = r.enabled_patterns || [];
    });
  } catch(e) {
    console.error('シフトパターン設定の読み込みエラー:', e);
    // 失敗時は空でフォールバック（renderShiftPatternOptionsがデフォルトを使う）
    shiftPatternSettings = {};
  }
  renderShiftPatternOptions();
}

async function saveShiftPatternSettings() {
  // 現在のチェック状態を取得
  const checked = SHIFT_PATTERN_OPTIONS
    .filter(s => document.getElementById(`sp-${s.id}`)?.checked)
    .map(s => s.id);
  shiftPatternSettings[currentDept] = checked;

  try {
    // upsert: 既存ならupdate、なければinsert
    await sb('dept_shift_pattern_settings', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ dept_id: currentDept, enabled_patterns: checked })
    });
    showToast(`${DEPT_NAMES[currentDept]}の設定を保存しました ✓`, 'success', 1500);
  } catch(e) {
    console.error('シフトパターン設定の保存エラー:', e);
    showToast('保存に失敗しました', 'error');
  }
}

function renderShiftPatternOptions() {
  const el = document.getElementById('shiftPatternOptions');
  if (!el) return;
  const enabled = shiftPatternSettings[currentDept] || DEFAULT_SHIFT_PATTERNS[currentDept] || SHIFT_PATTERN_OPTIONS.map(s => s.id);
  el.innerHTML = SHIFT_PATTERN_OPTIONS.map(s => {
    const isChecked = enabled.includes(s.id);
    return `<label style="display:inline-flex;align-items:center;gap:8px;padding:8px 12px;
      background:${isChecked?'#eff6ff':'white'};
      border:1.5px solid ${isChecked?'var(--primary)':'var(--border)'};
      border-radius:10px;cursor:pointer;transition:all 0.15s;width:fit-content;flex:0 0 auto">
      <input type="checkbox" id="sp-${s.id}" ${isChecked?'checked':''}
        onchange="this.closest('label').style.background=this.checked?'#eff6ff':'white';this.closest('label').style.borderColor=this.checked?'var(--primary)':'var(--border)';saveShiftPatternSettings();"
        style="width:15px;height:15px;accent-color:var(--primary);cursor:pointer">
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--text)">${s.label}</div>
        <div style="font-size:10px;color:var(--text-muted)">${s.time}</div>
      </div>
    </label>`;
  }).join('');
}

function getEnabledShiftPatterns() {
  return SHIFT_PATTERN_OPTIONS
    .filter(s => document.getElementById(`sp-${s.id}`)?.checked)
    .map(s => s.id);
}

async function loadGenPage() {
  // 水曜種別データを生成用に読み込み（UIは設定タブへ移動済み・全部署共通）
  wedTypes = await loadWedTypesMap(genYear, genMonth);
  loadShiftPatternSettings();
}


// ===== SHIFT AUTO GENERATE =====

document.getElementById('generateBtn').addEventListener('click', async () => {
  showLoading();
  try {
    const deptStaff = allStaff.filter(s => s.dept_id === currentDept).sort((a, b) => {
      const aOrder = a.display_order ?? 99999;
      const bOrder = b.display_order ?? 99999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.staff_code - b.staff_code;
    });
    if (!deptStaff.length) { showToast('スタッフがいません','error'); hideLoading(); return; }

    const ids = deptStaff.map(s => `"${s.id}"`).join(',');

    // ★ 確定ロックチェック：生成対象（genYear/genMonth/currentDept）が確定済みなら中止
    //   現在表示中とは別の月を生成しようとした場合も保護する。
    const _genIdSet = new Set(deptStaff.map(s => s.id));
    const confirmedCheck = ((await adminApi('/api/data', { action:'list', table:'shifts', view:'admin-month', params:{ year:genYear, month:genMonth } })).rows || []).filter(r => _genIdSet.has(r.staff_id) && r.is_confirmed === true);
    if (confirmedCheck.length > 0) {
      hideLoading();
      const deptLabel = DEPT_NAMES[currentDept] || `部署${currentDept}`;
      alert(
        '【操作不可】\n\n' +
        `${deptLabel} ${genYear}年${genMonth}月のシフト表は確定済み・スタッフに公開中です。\n` +
        'シフト自動生成で上書きするには、先に確定を取り消してください。\n\n' +
        'シフト表タブで該当月を表示し、「確定を取り消して編集する」を押してください。'
      );
      return;
    }

    const daysInMonth = new Date(genYear, genMonth, 0).getDate();

    // データ取得
    const [requests, existingShifts, requirements, monthlyHoursData, staffSettingsData, specialDaysData, thursdayData2, beginnerLimitsRaw, cellLocksData] = await Promise.all([
      adminApi('/api/data', { action:'list', table:'shift_requests', view:'admin-month', params:{ year:genYear, month:genMonth } }).then(r => (r.rows || []).filter(x => _genIdSet.has(x.staff_id))),
      adminApi('/api/data', { action:'list', table:'shifts', view:'admin-month', params:{ year:genYear, month:genMonth } }).then(r => (r.rows || []).filter(x => _genIdSet.has(x.staff_id))),
      sb(`staffing_requirements?dept_id=eq.${currentDept}&select=period_id,day_type,min_count`),
      sb(`monthly_hours?month=eq.${genMonth}&year=eq.${genYear}&dept_id=is.null&select=hours`),
      sb(`staff_settings?staff_id=in.(${ids})&year=eq.${genYear}&month=eq.${genMonth}&select=*`),
      sb(`special_days?year=eq.${genYear}&month=eq.${genMonth}&select=day,day_type,is_closed,is_holiday,label`),
      sb(`thursday_types?year=eq.${genYear}&month=eq.${genMonth}&select=day,is_open`),
      sb(`beginner_limits?dept_id=eq.${currentDept}&select=period_id,day_type,max_beginners`),
      // ★ 未選択セルのロック（cell_locks）も読み込み。テーブル未作成時は空配列。
      adminApi('/api/data', { action:'list', table:'cell_locks', view:'admin-month', params:{ year:genYear, month:genMonth } }).then(r => (r.rows || []).filter(x => _genIdSet.has(x.staff_id))).catch(() => [])
    ]);

    // 初心者上限マップ
    const beginnerLimitMap = {};
    beginnerLimitsRaw.forEach(b => {
      const key = `${b.period_id}-${b.day_type}`;
      beginnerLimitMap[key] = b.max_beginners;
    });

    function getBeginnerLimit(period, d) {
      const dt = getDayType(d);
      const key = `${period}-${dt}`;
      return beginnerLimitMap[key] ?? null; // nullは制限なし
    }

    // 祝日（カレンダー上）
    const holidays = getJapaneseHolidays(genYear, genMonth);

    // 祝日・木曜・任意休診日の設定マップ
    const closedHolidays = new Set(); // 休診祝日
    const customClosedDays = new Set(); // 任意休診日
    specialDaysData.forEach(s => {
      if (!s.is_closed) return;
      // 祝日 → 祝日休診扱い
      // 祝日でない → 任意休診日
      if (holidays.has(s.day) || s.is_holiday === true) {
        closedHolidays.add(s.day);
      } else {
        customClosedDays.add(s.day);
      }
    });
    const openThursdays = new Set(); // 診療木曜
    thursdayData2.forEach(t => { if (t.is_open) openThursdays.add(t.day); });

    const basePlanHours = monthlyHoursData.length > 0 ? monthlyHoursData[0].hours : APP_DEFAULT_PLAN_HOURS;

    // スタッフごとの所定時間・夜勤上限を計算
    const staffSettingsMap = {};
    staffSettingsData.forEach(s => { staffSettingsMap[s.staff_id] = s; });

    function getStaffPlanHours(staff) {
      const custom = staffSettingsMap[staff.id];
      if (custom?.planned_hours != null) return custom.planned_hours;
      if (staff.emp_type === 'full') return basePlanHours;
      if (staff.emp_type === 'short') return Math.round(basePlanHours * APP_SHORT_RATIO * 10) / 10;
      return 0; // part: 個別設定なければ0
    }

    function getStaffMaxNight(staff) {
      const custom = staffSettingsMap[staff.id];
      if (custom?.max_night_per_month != null) return custom.max_night_per_month;
      return 8;
    }

    function getStaffMaxLate(staff) {
      const custom = staffSettingsMap[staff.id];
      return custom?.max_late_per_month ?? 99;
    }

    function getStaffMaxLong(staff) {
      const custom = staffSettingsMap[staff.id];
      return custom?.max_long_per_month ?? 99;
    }

    function getStaffMaxMid(staff) {
      const custom = staffSettingsMap[staff.id];
      return custom?.max_mid_per_month ?? 99;
    }

    function isNoNightAuto(staff) {
      const custom = staffSettingsMap[staff.id];
      return custom?.no_night_auto === true || staff.no_night === true;
    }

    // 🌸スタッフは必要人数カウントに含めない
    function isNoCount(staff) {
      return staff.skill_level === 'no_count' || staff.no_count === true;
    }

    // オプション5つは常時ON固定（UI非表示）
    const optRespectRequest = true;
    const optRespectHours = true;
    const optRespectNight = true;
    const optKeepLocked = true;
    const optFillRequired = true;
    // 土日連勤なしのみUIから取得
    const optNoConsecWeekend = document.getElementById('optNoConsecWeekend')?.checked ?? true;

    // 希望マップ
    const reqMap = {};
    requests.forEach(r => { reqMap[`${r.staff_id}|${r.day}`] = r.request_type; });

    // lockMapはSTEP0で定義

    // 必要人数マップ
    const reqCountMap = {};
    requirements.forEach(r => {
      if (!reqCountMap[r.period_id]) reqCountMap[r.period_id] = {};
      reqCountMap[r.period_id][r.day_type] = r.min_count;
    });

    // 祝日（上で getJapaneseHolidays 取得済み）

    function getDayType(d) {
      const dow = new Date(genYear, genMonth-1, d).getDay();
      // 任意休診日（最優先）
      if (customClosedDays.has(d)) return 'clinic_closed';
      // 休診祝日は weekend扱いしない → 必要人数0として処理
      if (holidays.has(d) && closedHolidays.has(d)) return 'holiday_closed';
      if (holidays.has(d)) return 'holiday_jp'; // 診療祝日
      if (dow === 0 || dow === 6) return 'weekend';
      if (dow === 3) return wedTypes[d] === 'cc' ? 'wed_cc' : wedTypes[d] === 'cho' ? 'wed_cho' : 'wed_normal';
      if (dow === 4) return openThursdays.has(d) ? 'thu_open' : 'thu_closed';
      return 'weekday';
    }

    function getRequired(period, day) {
      const dayType = getDayType(day);
      // 休診日（休診祝日・休診木曜・任意休診日）は必要人数0
      if (dayType === 'holiday_closed' || dayType === 'thu_closed' || dayType === 'clinic_closed') return 0;
      return reqCountMap[period]?.[dayType] ?? null;
    }

    // 休診日かどうか
    function isClosedDay(d) {
      const dayType = getDayType(d);
      return dayType === 'holiday_closed' || dayType === 'thu_closed' || dayType === 'clinic_closed';
    }

    // ===== 生成ロジック =====
    const result = {};

    // 使用シフトパターンを取得
    const enabledPatterns = getEnabledShiftPatterns();

    // スタッフごとのトラッキング変数
    const staffHours = {}, staffNightCount = {}, staffLongCount = {}, staffMidCount = {}, staffLateCount = {};
    deptStaff.forEach(s => {
      staffHours[s.id] = 0;
      staffNightCount[s.id] = 0;
      staffLongCount[s.id] = 0;
      staffMidCount[s.id] = 0;
      staffLateCount[s.id] = 0;
    });
    // 遅番系シフト LATE_SHIFTS はグローバル定義を使用（カスタムシフト対応）

    // ===== デバッグログ初期化 =====
    const _genLog = [];
    const _logStep = (label) => {
      const stats = {
        埋まったセル数: Object.keys(result).length,
        スタッフ別時間: {}
      };
      deptStaff.forEach(s => {
        stats.スタッフ別時間[s.name] = (staffHours[s.id]||0).toFixed(1) + 'h / ' + getStaffPlanHours(s) + 'h';
      });
      _genLog.push({step: label, ...stats});
    };
    console.log('[自動生成] 開始', {
      部門: currentDept, 年月: `${genYear}/${genMonth}`,
      スタッフ数: deptStaff.length, 所定時間: basePlanHours,
      オプション: { optRespectRequest, optRespectHours, optRespectNight, optKeepLocked, optFillRequired }
    });

    // ===== STEP0: ロック済みシフトを反映 =====
    // 現在のメモリ状態を保存（ユーザーが画面で設定したロック・シフト変更）
    const memoryLockedCellsSnapshot = {...lockedCells};
    const memoryShiftDataSnapshot = {...shiftData};

    // lockedCellsをリセット（前回の値が残っているとSTEP7/8で誤動作）
    lockedCells = {};
    const lockMap = {};
    if (optKeepLocked) {
      // 1. DB shifts.is_locked から：シフト入りロック済みセル
      existingShifts.forEach(s => {
        if (s.is_locked) {
          const key = `${s.staff_id}|${s.day}`;
          lockMap[key] = s.shift_type_id;
          lockedCells[key] = true; // STEP7/STEP8/STEP9で参照
        }
      });
      // 2. ★ DB cell_locks から：未選択ロック済みセル
      //    旧コードはメモリスナップショットのみ参照していたため、
      //    異なる月で生成する場合や、メモリ状態が更新前の状態だと
      //    未選択ロックが拾えず、AIが上書きしてしまうバグがあった。
      (cellLocksData || []).forEach(c => {
        const key = `${c.staff_id}|${c.day}`;
        if (lockedCells[key]) return; // 既にDBから反映済み
        lockMap[key] = ''; // 未選択を表す
        lockedCells[key] = true;
      });
      // 3. メモリスナップショット：未保存のセッション内ロック
      //    ※genYear/genMonth と shiftYear/shiftMonth が一致する場合のみ意味がある
      //      （キーが staffId|day で年月情報を持たないため、別月だと誤適用される）
      if (genYear === shiftYear && genMonth === shiftMonth) {
        Object.keys(memoryLockedCellsSnapshot).forEach(key => {
          if (lockedCells[key]) return;
          lockedCells[key] = true;
          // メモリ上のシフト値を保存（未設定なら空文字）
          lockMap[key] = memoryShiftDataSnapshot[key] || '';
        });
      }
    }
    Object.entries(lockMap).forEach(([key, shift]) => {
      result[key] = shift;
      const [sid] = parseKey(key);
      staffHours[sid] = (staffHours[sid]||0) + (SHIFT_HOURS[shift]||0);
      if (NIGHT_SHIFTS.includes(shift)) staffNightCount[sid] = (staffNightCount[sid]||0) + 1;
      if (LONG_SHIFTS.includes(shift)) staffLongCount[sid] = (staffLongCount[sid]||0) + 1;
      if (MID_BREAK_SHIFTS.includes(shift)) staffMidCount[sid] = (staffMidCount[sid]||0) + 1;
      if (LATE_SHIFTS.includes(shift)) staffLateCount[sid] = (staffLateCount[sid]||0) + 1;
    });

    // 時短スタッフに割り当て可能なシフト
    const SHORT_ALLOWED = new Set(['時短','CC','CCのみ','CHO','休み','有休','半有休','個夏休','希望休']);

    // 時短スタッフ用のシフト変換関数
    function toShortShift(shift, dt) {
      if (!shift) return shift;
      if (['休み','有休','半有休','個夏休','希望休'].includes(shift)) return shift;
      if (dt === 'wed_cc') return ['CC','CCのみ'].includes(shift) ? shift : 'CC';
      if (dt === 'wed_cho') return 'CHO';
      return '時短'; // 通常日は時短に変換
    }

_logStep('STEP0完了'); 
    // ===== STEP1: 休診日は全員「休み」=====
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(genYear, genMonth-1, d).getDay();
      const dt = getDayType(d);
      if (dow === 4 && !openThursdays.has(d) || (holidays.has(d) && closedHolidays.has(d))) {
        deptStaff.forEach(staff => {
          const key = `${staff.id}|${d}`;
          // ★ lockedCells で判定（旧コードは !lockMap[key] で判定していたが、
          //    未選択ロックは lockMap[key]='' になるため !'' = true で
          //    休みに上書きされてしまうバグがあった）
          if (!lockedCells[key]) result[key] = '休み';
        });
      }
    }

_logStep('STEP1完了'); 
    // ===== STEP2: 希望休・有休を反映 =====
    if (optRespectRequest) {
      deptStaff.forEach(staff => {
        for (let d = 1; d <= daysInMonth; d++) {
          const key = `${staff.id}|${d}`;
          if (result[key] || lockedCells[key]) continue;
          const req = reqMap[key];
          if (req && OFF_SHIFTS.includes(req)) {
            result[key] = req;
            if (PAID_LEAVE_SHIFTS.includes(req)) {
              const dt = new Date(genYear, genMonth - 1, d);
              staffHours[staff.id] = (staffHours[staff.id]||0) + getYukyuHours(dt.getDay(), holidays.has(d));
            }
            if (req === '半有休') staffHours[staff.id] = (staffHours[staff.id]||0) + 5;
          }
        }
      });
    }

_logStep('STEP2完了'); 
    // ===== STEP3: 曜日固定シフトを反映 =====
    // 土日連勤チェック関数（STEP3用に前方宣言）
    const wouldCauseWeekendConsecPre = (staffId, d) => {
      if (!optNoConsecWeekend) return false;
      const dow = new Date(genYear, genMonth-1, d).getDay();
      if (dow === 6 && d + 1 <= daysInMonth) {
        const sundayShift = result[`${staffId}|${d+1}`];
        if (sundayShift && !OFF_SHIFTS.includes(sundayShift)) return true;
      }
      if (dow === 0 && d - 1 >= 1) {
        const saturdayShift = result[`${staffId}|${d-1}`];
        if (saturdayShift && !OFF_SHIFTS.includes(saturdayShift)) return true;
      }
      return false;
    };
    deptStaff.forEach(staff => {
      const fixedShifts = staff.fixed_shifts || {};
      if (!Object.keys(fixedShifts).length) return;
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${staff.id}|${d}`;
        if (result[key] || lockedCells[key]) continue;
        const dt = getDayType(d);
        if (dt === 'thu_closed' || dt === 'holiday_closed' || dt === 'clinic_closed') continue;
        const dow = new Date(genYear, genMonth-1, d).getDay();
        const fixedShift = fixedShifts[dow] || fixedShifts[String(dow)];
        if (!fixedShift) continue;
        // 土日連勤チェック（休み系は除外）
        if (!OFF_SHIFTS.includes(fixedShift) && wouldCauseWeekendConsecPre(staff.id, d)) continue;
        // CC/CHO日は専用シフトのみ
        if (dt === 'wed_cc' && !['CC','CCのみ','休み','有休','半有休','個夏休','希望休'].includes(fixedShift)) continue;
        if (dt === 'wed_cho' && !['CHO','休み','有休','半有休','個夏休','希望休'].includes(fixedShift)) continue;
        const planH = getStaffPlanHours(staff);
        if (optRespectHours && planH > 0 && (staffHours[staff.id]||0) + (SHIFT_HOURS[fixedShift]||0) > planH + 2) continue;
        // 時短スタッフはシフトを変換
        const finalFixedShift = staff.emp_type === 'short' ? toShortShift(fixedShift, dt) : fixedShift;
        result[key] = finalFixedShift;
        staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS[finalFixedShift]||0);
        if (NIGHT_SHIFTS.includes(finalFixedShift)) staffNightCount[staff.id] = (staffNightCount[staff.id]||0) + 1;
        if (LATE_SHIFTS.includes(finalFixedShift)) staffLateCount[staff.id] = (staffLateCount[staff.id]||0) + 1;
        if (LONG_SHIFTS.includes(finalFixedShift)) staffLongCount[staff.id] = (staffLongCount[staff.id]||0) + 1;
        if (MID_BREAK_SHIFTS.includes(finalFixedShift)) staffMidCount[staff.id] = (staffMidCount[staff.id]||0) + 1;
      }
    });

_logStep('STEP3完了'); 
    // ===== STEP4: 日ごとに必要人数を充足 =====
    // ヘルパー関数（ローカルスコープで定義）
    const countCoverage = (staff, d, period) => staff.filter(s => {
      if (isNoCount(s)) return false;
      const sh = result[`${s.id}|${d}`];
      return sh && SHIFT_COVERS[sh]?.includes(period);
    }).length;

    // 土日連勤チェック: staffId が day に勤務すると土日連続出勤になるか判定
    // 戻り値 true = 配置すべきでない（連勤になる）
    const wouldCauseWeekendConsec = (staffId, d) => {
      if (!optNoConsecWeekend) return false;
      const dow = new Date(genYear, genMonth-1, d).getDay();
      // 土曜の場合、翌日(日曜)を確認
      if (dow === 6 && d + 1 <= daysInMonth) {
        const sundayShift = result[`${staffId}|${d+1}`];
        if (sundayShift && !OFF_SHIFTS.includes(sundayShift)) return true;
      }
      // 日曜の場合、前日(土曜)を確認
      if (dow === 0 && d - 1 >= 1) {
        const saturdayShift = result[`${staffId}|${d-1}`];
        if (saturdayShift && !OFF_SHIFTS.includes(saturdayShift)) return true;
      }
      return false;
    };

    const getAssignCandidates = (staff, d, dt, period, shift, pass = 0) => staff.filter(s => {
      const key = `${s.id}|${d}`;
      // ★ lockedCells も判定（旧コードは result[key] のみ。未選択ロックは result[key]=''
      //    で if ('') = false となり、AI 候補に含まれてしまうバグがあった）
      if (result[key] || lockedCells[key]) return false;
      // 🌸スタッフは必要人数充足ロジックから完全に除外（STEP9で個別に所定時間補完される）
      if (isNoCount(s)) return false;
      const planH = getStaffPlanHours(s);
      if (planH <= 0) return false;
      if (s.emp_type === 'short') {
        if (period === 'evening') return false;
        if (period === 'afternoon' && dt !== 'wed_cc' && dt !== 'wed_cho') return false;
      }
      if (period === 'evening' && isNoNightAuto(s)) return false;
      // 所定時間チェック（全passで ±2H 厳守）
      if (optRespectHours && planH > 0) {
        const projectedH = (staffHours[s.id]||0) + (SHIFT_HOURS[shift]||0);
        if (projectedH > planH + 2) return false;
      }
      // 土日連勤チェック
      if (wouldCauseWeekendConsec(s.id, d)) return false;
      // 月間上限チェック（夜勤・遅番・長日・中抜け）
      if (NIGHT_SHIFTS.includes(shift)) {
        if ((staffNightCount[s.id]||0) >= getStaffMaxNight(s)) return false;
      }
      if (LATE_SHIFTS.includes(shift)) {
        if ((staffLateCount[s.id]||0) >= getStaffMaxLate(s)) return false;
      }
      if (LONG_SHIFTS.includes(shift)) {
        if ((staffLongCount[s.id]||0) >= getStaffMaxLong(s)) return false;
      }
      if (MID_BREAK_SHIFTS.includes(shift)) {
        if ((staffMidCount[s.id]||0) >= getStaffMaxMid(s)) return false;
      }
      return true;
    }).sort((a, b) => {
      if (a.skill_level === 'beginner' && b.skill_level !== 'beginner') return 1;
      if (a.skill_level !== 'beginner' && b.skill_level === 'beginner') return -1;
      if (period === 'evening') return (staffNightCount[a.id]||0) - (staffNightCount[b.id]||0);
      return (staffHours[a.id]||0) - (staffHours[b.id]||0);
    });


    // 優先順：遅番/遅L → 日勤/日勤+ → 長日 → 午前/午後
    if (optFillRequired) {
      for (let d = 1; d <= daysInMonth; d++) {
        const dt = getDayType(d);
        if (dt === 'thu_closed' || dt === 'holiday_closed' || dt === 'clinic_closed') continue;
        const dow = new Date(genYear, genMonth-1, d).getDay();

        // CC/CHO日は専用ロジック（selectDayShiftに任せる）
        if (dt === 'wed_cc' || dt === 'wed_cho') {
          for (const period of ['morning','afternoon']) {
            if (dt === 'wed_cho' && period === 'afternoon') continue;
            const req = getRequired(period, d);
            if (!req || req <= 0) continue;
            const shift = selectDayShift(period, currentDept, dt, enabledPatterns);
            if (!shift) continue;
            const covered = deptStaff.filter(s => {
              if (isNoCount(s)) return false;
              return SHIFT_COVERS[result[`${s.id}|${d}`]]?.includes(period);
            }).length;
            if (covered >= req) continue;
            const need = req - covered;
            const cands = getAssignCandidates(deptStaff, d, dt, period, shift);
            let added = 0;
            for (const s of cands) {
              if (added >= need) break;
              result[`${s.id}|${d}`] = shift;
              staffHours[s.id] = (staffHours[s.id]||0) + (SHIFT_HOURS[shift]||0);
              added++;
            }
          }
          continue;
        }

        // 通常日の割り当て
        // 【重要】getRequired は「未設定」を null、「明示的に0人」を 0 で返す。
        //   null（未設定）= 人数制約なし → STEP3では充足判定を行わない（STEP8/バランスが自由に配置）
        //   0（明示ゼロ）  = 誰も配置しない（特別日の休診表現など）
        // 旧実装は `|| 0` で両者を 0 に潰しており、未設定の枠に永久に人が入らなかった。
        const mReqRaw = getRequired('morning', d);
        const aReqRaw = getRequired('afternoon', d);
        const eReqRaw = getRequired('evening', d);
        const mReq = (mReqRaw == null) ? 0 : mReqRaw;
        const aReq = (aReqRaw == null) ? 0 : aReqRaw;
        const eReq = (eReqRaw == null) ? 0 : eReqRaw;

        // PASS1: 遅番/遅Lで午後+夜間を充足（1人ごとに再評価）
        const eveningShifts = currentDept === 2 ? ['リハ遅'] : ['遅番','遅L'].filter(s => enabledPatterns.includes(s));
        for (const sh of eveningShifts) {
          if (!enabledPatterns.includes(sh)) continue;
          for (let pass = 0; pass < 3; pass++) {
            let placedInThisPass = 0;
            while (true) {
              const aCov = countCoverage(deptStaff, d, 'afternoon');
              const eCov = countCoverage(deptStaff, d, 'evening');
              const eveningNeeded = (eReq > 0 && eCov < eReq);
              const afternoonNeeded = (aReq > 0 && aCov < aReq);
              // 夜間が満たされていれば、午後だけのために遅番は配置しない（過剰配置防止）
              if (!eveningNeeded) break;
              const cands = getAssignCandidates(deptStaff, d, dt, 'evening', sh, pass);
              if (cands.length === 0) break;
              const s = cands[0];
              result[`${s.id}|${d}`] = sh;
              staffHours[s.id] = (staffHours[s.id]||0) + (SHIFT_HOURS[sh]||0);
              staffNightCount[s.id] = (staffNightCount[s.id]||0) + 1;
              if (LATE_SHIFTS.includes(sh)) staffLateCount[s.id] = (staffLateCount[s.id]||0) + 1;
              placedInThisPass++;
              if (placedInThisPass >= 5) break; // 暴走防止
            }
            if (placedInThisPass > 0) break;
          }
        }

        // PASS2: 日勤/日勤+で午前を充足
        const morningShifts = ['日勤','日勤+'].filter(s => enabledPatterns.includes(s));
        for (const sh of morningShifts) {
          for (let pass = 0; pass < 3; pass++) {
            const mCov = countCoverage(deptStaff, d, 'morning');
            if (mCov >= mReq) break;
            const need = mReq - mCov;
            const cands = getAssignCandidates(deptStaff, d, dt, 'morning', sh, pass);
            let added = 0;
            for (const s of cands) {
              if (added >= need) break;
              const finalSh = s.emp_type === 'short' ? '時短' : sh;
              result[`${s.id}|${d}`] = finalSh;
              staffHours[s.id] = (staffHours[s.id]||0) + (SHIFT_HOURS[finalSh]||0);
              added++;
            }
            if (added > 0) break;
          }
        }

        // PASS3: 長日で不足を補完（長日は3時間帯すべてカバー）
        if (enabledPatterns.includes('長日')) {
          for (let pass = 0; pass < 3; pass++) {
            // ループ内で都度確認し、1人配置ごとに再評価
            let placedInThisPass = 0;
            while (true) {
              const mCov = countCoverage(deptStaff, d, 'morning');
              const aCov = countCoverage(deptStaff, d, 'afternoon');
              const eCov = countCoverage(deptStaff, d, 'evening');
              if (mCov >= mReq && aCov >= aReq && eCov >= eReq) break;
              const cands = getAssignCandidates(deptStaff, d, dt, 'morning', '長日', pass);
              if (cands.length === 0) break;
              const s = cands[0];
              result[`${s.id}|${d}`] = '長日';
              staffHours[s.id] = (staffHours[s.id]||0) + (SHIFT_HOURS['長日']||0);
              if (NIGHT_SHIFTS.includes('長日')) staffNightCount[s.id] = (staffNightCount[s.id]||0) + 1;
              staffLongCount[s.id] = (staffLongCount[s.id]||0) + 1;
              placedInThisPass++;
              if (placedInThisPass >= 5) break; // 暴走防止
            }
            if (placedInThisPass > 0) break;
          }
        }

        // PASS4: 午前/午後で残りを補完
        for (const [sh, period] of [['午前','morning'],['午後','afternoon']]) {
          if (!enabledPatterns.includes(sh)) continue;
          for (let pass = 0; pass < 3; pass++) {
            const cov = countCoverage(deptStaff, d, period);
            const req = period === 'morning' ? mReq : aReq;
            if (cov >= req) break;
            const need = req - cov;
            const cands = getAssignCandidates(deptStaff, d, dt, period, sh, pass);
            let added = 0;
            for (const s of cands) {
              if (added >= need) break;
              const finalSh = s.emp_type === 'short' ? '時短' : sh;
              result[`${s.id}|${d}`] = finalSh;
              staffHours[s.id] = (staffHours[s.id]||0) + (SHIFT_HOURS[finalSh]||0);
              added++;
            }
            if (added > 0) break;
          }
        }
      }
    }

_logStep('STEP4完了'); 
    // ===== STEP5: 希望勤務シフトを反映 =====
    if (optRespectRequest) {
      deptStaff.forEach(staff => {
        for (let d = 1; d <= daysInMonth; d++) {
          const key = `${staff.id}|${d}`;
          if (result[key] || lockedCells[key]) continue;
          const req = reqMap[key];
          if (!req) continue;
          // 希望が「休み系」ならSTEP2で処理済みなのでここはスキップ
          if (OFF_SHIFTS.includes(req)) continue;
          const dt = getDayType(d);
          if (dt === 'thu_closed' || dt === 'holiday_closed' || dt === 'clinic_closed') continue;
          // CC日はCC・CCのみ以外の勤務不可
          if (dt === 'wed_cc' && !['CC','CCのみ','休み','有休','半有休','個夏休','希望休'].includes(req)) continue;
          // CHO日はCHO以外の勤務不可
          if (dt === 'wed_cho' && !['CHO','休み','有休','半有休','個夏休','希望休'].includes(req)) continue;
          const planH = getStaffPlanHours(staff);
          if (optRespectHours && planH > 0 && (staffHours[staff.id]||0) + (SHIFT_HOURS[req]||0) > planH + 2) continue;
          // 土日連勤チェック
          if (wouldCauseWeekendConsec(staff.id, d)) continue;
          result[key] = req;
          staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS[req]||0);
          if (NIGHT_SHIFTS.includes(req)) staffNightCount[staff.id] = (staffNightCount[staff.id]||0) + 1;
          if (LATE_SHIFTS.includes(req)) staffLateCount[staff.id] = (staffLateCount[staff.id]||0) + 1;
          if (LONG_SHIFTS.includes(req)) staffLongCount[staff.id] = (staffLongCount[staff.id]||0) + 1;
          if (MID_BREAK_SHIFTS.includes(req)) staffMidCount[staff.id] = (staffMidCount[staff.id]||0) + 1;
        }
      });
    }

_logStep('STEP5完了'); 
    // ===== STEP6: 所定時間に達していないスタッフに日勤を追加 =====
    deptStaff.forEach(staff => {
      const planH = getStaffPlanHours(staff);
      // 所定時間0Hのスタッフは全日休み
      if (planH <= 0) {
        for (let d = 1; d <= daysInMonth; d++) {
          const key = `${staff.id}|${d}`;
          if (!result[key] && !lockedCells[key]) result[key] = '休み';
        }
        return;
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${staff.id}|${d}`;
        if (result[key] || lockedCells[key]) continue;
        const dt2 = getDayType(d);
        // 休診日のみ休み。
        // 【修正】土日祝は診療日のため、旧実装の「日曜=一律休み」「土曜=時短以外休み」を撤廃。
        //   土日連勤の抑止は wouldCauseWeekendConsec()（下の候補判定）が担う。
        if (dt2 === 'thu_closed' || dt2 === 'holiday_closed' || dt2 === 'clinic_closed') {
          result[key] = '休み';
          continue;
        }
        // 土日連勤になる日は配置しない
        if (wouldCauseWeekendConsec(staff.id, d)) {
          result[key] = '休み';
          continue;
        }
        // 所定時間に達したら休み（±2H許容）
        if ((staffHours[staff.id]||0) >= planH - 0.5) {
          result[key] = '休み';
          continue;
        }
        // 時短スタッフはCC/CHO日も活用
        if (staff.emp_type === 'short') {
          if (dt2 === 'wed_cc') {
            const ccShift = 'CC';
            // 必要人数を超過させないよう確認
            const ccReqRaw = getRequired('morning', d);   // null=未設定（人数制約なし）
            const ccCov = countCoverage(deptStaff, d, 'morning');
            const ccRoom = (ccReqRaw == null) ? true : (ccCov < ccReqRaw + 1);
            if (ccRoom && (staffHours[staff.id]||0) + SHIFT_HOURS[ccShift] <= planH + 2) {
              result[key] = ccShift;
              staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS[ccShift]||0);
              continue;
            }
            result[key] = '休み';
            continue;
          }
          if (dt2 === 'wed_cho') {
            const choShift = 'CHO';
            const choReqRaw = getRequired('morning', d);  // null=未設定（人数制約なし）
            const choCov = countCoverage(deptStaff, d, 'morning');
            const choRoom = (choReqRaw == null) ? true : (choCov < choReqRaw + 1);
            if (choRoom && (staffHours[staff.id]||0) + SHIFT_HOURS[choShift] <= planH + 2) {
              result[key] = choShift;
              staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS[choShift]||0);
              continue;
            }
            result[key] = '休み';
            continue;
          }
          if (dt2 === 'wed_normal') {
            // 通常水曜は午前のみ診療 → 時短シフト（午前帯）で勤務可
            if ((staffHours[staff.id]||0) + SHIFT_HOURS['時短'] <= planH + 2) {
              result[key] = '時短';
              staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS['時短']||0);
              continue;
            }
            result[key] = '休み';
            continue;
          }
          // 平日・木曜診療日: 時短シフトを追加（許容値+2H）
          if ((staffHours[staff.id]||0) + SHIFT_HOURS['時短'] <= planH + 2) {
            result[key] = '時短';
            staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS['時短']||0);
            continue;
          }
          result[key] = '休み';
          continue;
        }
        // 常勤・パート
        // 【修正】旧実装は水曜(通常/CC/CHO)を一律「休み」にしていたため、水曜午前が選ばれなかった。
        //   通常水曜=午前のみ診療、CC日=CC、CHO日=CHO を正しく割り当てる。
        if (dt2 === 'wed_cc' || dt2 === 'wed_cho') {
          const wShift = (dt2 === 'wed_cc') ? 'CC' : 'CHO';
          if ((staffHours[staff.id]||0) + (SHIFT_HOURS[wShift]||0) <= planH + 2) {
            result[key] = wShift;
            staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS[wShift]||0);
          } else {
            result[key] = '休み';
          }
          continue;
        }
        if (dt2 === 'wed_normal') {
          // 通常水曜は午前のみ診療 → 午後をカバーしない「午前」シフト
          if ((staffHours[staff.id]||0) + (SHIFT_HOURS['午前']||0) <= planH + 2) {
            result[key] = '午前';
            staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS['午前']||0);
          } else {
            result[key] = '休み';
          }
          continue;
        }
        // 日勤を追加（許容値+2H）
        if ((staffHours[staff.id]||0) + SHIFT_HOURS['日勤'] <= planH + 2) {
          result[key] = '日勤';
          staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS['日勤']||0);
        } else {
          result[key] = '休み';
        }
      }
      // 残りは全て休み
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${staff.id}|${d}`;
        if (!result[key] && !lockedCells[key]) result[key] = '休み';
      }
    });

_logStep('STEP6完了'); 
    // ===== STEP7: 超過削減（必要人数を超えたスタッフを休みに変換）=====
    // GASロジックと同様：優先度の低いシフトから削除
    const removeRank = (shift) => {
      if (shift === '中抜け') return 100;
      if (shift === '長日') return 90;
      if (shift === '午後' || shift === '時短') return 80;
      if (shift === '午前') return 60;
      if (shift === '日勤') return 40;
      if (shift === '日勤+') return 35;
      if (shift === '遅L') return 25;
      if (shift === '夜勤') return 10;
      return 50;
    };
    let changed7 = true, guard7 = 0;
    while (changed7 && guard7++ < 1000) {
      changed7 = false;
      for (let d = 1; d <= daysInMonth; d++) {
        const dt7 = getDayType(d);
        if (dt7 === 'thu_closed' || dt7 === 'holiday_closed' || dt7 === 'clinic_closed') continue;
        for (const period of ['morning','afternoon','evening']) {
          const req = getRequired(period, d);
          if (!req || req <= 0) continue;
          // 現在の充足数（🌸除外）
          const covered7 = deptStaff.filter(s => {
            if (isNoCount(s)) return false;
            const sh = result[`${s.id}|${d}`];
            return sh && SHIFT_COVERS[sh]?.includes(period);
          }).length;
          if (covered7 <= req) continue;
          // 超過あり → 削除候補を探す（優先度高い=削除しやすい）
          const removable = deptStaff
            .filter(s => {
              if (isNoCount(s)) return false;
              const key = `${s.id}|${d}`;
              if (lockedCells[key]) return false;
              const sh = result[key];
              if (!sh || !SHIFT_COVERS[sh]?.includes(period)) return false;
              // 削除しても他の時間帯の充足が維持されるか確認
              const otherPeriods = ['morning','afternoon','evening'].filter(p => p !== period);
              for (const op of otherPeriods) {
                const req2 = getRequired(op, d);
                if (!req2 || req2 <= 0) continue;
                const cov2 = deptStaff.filter(s2 => {
                  if (isNoCount(s2)) return false;
                  const sh2 = s2.id === s.id ? '休み' : result[`${s2.id}|${d}`];
                  return sh2 && SHIFT_COVERS[sh2]?.includes(op);
                }).length;
                if (cov2 < req2) return false; // 削除すると他が不足になる
              }
              return true;
            })
            .sort((a, b) => removeRank(result[`${b.id}|${d}`]) - removeRank(result[`${a.id}|${d}`]));

          if (removable.length > 0) {
            result[`${removable[0].id}|${d}`] = '休み';
            changed7 = true;
          }
        }
      }
    }

_logStep('STEP7完了'); 
    // ===== STEP8: 所定時間補完（不足スタッフに追加勤務）=====
    for (let pass8 = 0; pass8 < 3; pass8++) {
      const needWork = deptStaff
        .filter(s => !isNoCount(s) && getStaffPlanHours(s) > 0)
        .map(s => ({ s, need: getStaffPlanHours(s) - (staffHours[s.id]||0) }))
        .filter(x => x.need > 0.5)
        .sort((a, b) => b.need - a.need);
      if (!needWork.length) break;

      let changed8 = false;
      for (const { s, need } of needWork) {
        for (let d = 1; d <= daysInMonth; d++) {
          if ((staffHours[s.id]||0) >= getStaffPlanHours(s) - 0.1) break;
          const key = `${s.id}|${d}`;
          if (result[key] !== '休み') continue;
          if (lockedCells[key]) continue;
          const dt8 = getDayType(d);
          if (dt8 === 'thu_closed' || dt8 === 'holiday_closed' || dt8 === 'clinic_closed') continue;
          // 【修正】土日祝は診療日のため、日曜・土曜・通常水曜の一律除外を撤廃。
          //   旧実装は dow8===0 / dow8===6(非時短) / wed_normal を無条件スキップしており、
          //   「所定労働時間を満たす」補填がこれらの日に一切働かなかった（土日が休みになる主因）。
          //   土日連勤の抑止は下の wouldCauseWeekendConsec() が担う。

          // スコアリングで最適シフトを選択
          const candidates8 = (enabledPatterns.length > 0 ? enabledPatterns : ['日勤'])
            .filter(sh => {
              // CC/CHO日の制限
              if (dt8 === 'wed_cc' && !['CC','CCのみ'].includes(sh)) return false;
              if (dt8 === 'wed_cho' && sh !== 'CHO') return false;
              // 通常水曜は午前のみ診療 → 午後をカバーするシフトは不可
              if (dt8 === 'wed_normal' && !['午前','時短'].includes(sh)) return false;
              // 時短属性
              if (s.emp_type === 'short' && !['時短','CC','CCのみ','CHO'].includes(sh)) return false;
              if (s.emp_type !== 'short' && sh === '時短') return false;
              // 夜勤不可
              if (isNoNightAuto(s) && NIGHT_SHIFTS.includes(sh)) return false;
              // 月間上限チェック
              if (NIGHT_SHIFTS.includes(sh) && (staffNightCount[s.id]||0) >= getStaffMaxNight(s)) return false;
              if (LATE_SHIFTS.includes(sh) && (staffLateCount[s.id]||0) >= getStaffMaxLate(s)) return false;
              if (LONG_SHIFTS.includes(sh) && (staffLongCount[s.id]||0) >= getStaffMaxLong(s)) return false;
              if (MID_BREAK_SHIFTS.includes(sh) && (staffMidCount[s.id]||0) >= getStaffMaxMid(s)) return false;
              // 所定時間±2H厳守
              const projectedH8 = (staffHours[s.id]||0) + (SHIFT_HOURS[sh]||0);
              if (projectedH8 > getStaffPlanHours(s) + 2) return false;
              // 土日連勤チェック
              if (wouldCauseWeekendConsec(s.id, d)) return false;
              return true;
            })
            .map(sh => {
              let score = 0;
              const h = SHIFT_HOURS[sh] || 0;
              score -= Math.abs(h - Math.max(0, need)) * 100;
              if (sh === '日勤' || sh === '日勤+') score += 800;
              else if (sh === '時短') score += 500;
              else if (sh === '午前' || sh === '午後') score += 400;
              else if (sh === '遅番' || sh === '遅L') score += 300;
              else if (sh === '夜勤') score += 200;
              else if (sh === '長日') score -= 200;
              else if (sh === '中抜け') score -= 500;
              score += Math.random() * 10;
              return { sh, score };
            })
            .sort((a, b) => b.score - a.score);

          if (candidates8.length > 0) {
            const bestShift = candidates8[0].sh;
            result[key] = bestShift;
            staffHours[s.id] = (staffHours[s.id]||0) + (SHIFT_HOURS[bestShift]||0);
            if (NIGHT_SHIFTS.includes(bestShift)) staffNightCount[s.id] = (staffNightCount[s.id]||0) + 1;
            if (LATE_SHIFTS.includes(bestShift)) staffLateCount[s.id] = (staffLateCount[s.id]||0) + 1;
            if (LONG_SHIFTS.includes(bestShift)) staffLongCount[s.id] = (staffLongCount[s.id]||0) + 1;
            if (MID_BREAK_SHIFTS.includes(bestShift)) staffMidCount[s.id] = (staffMidCount[s.id]||0) + 1;
            changed8 = true;
          }
        }
      }
      if (!changed8) break;
    }

_logStep('STEP8完了'); 
    // ===== STEP9: 🌸スタッフの所定時間補完 =====
    deptStaff.filter(s => isNoCount(s)).forEach(s => {
      const planH = getStaffPlanHours(s);
      if (planH <= 0) return;
      // 【修正】旧実装は planH - 2 で打ち切っており、🌸だけ最大2時間の取りこぼしが常態化していた。
      //   通常スタッフ(STEP8)と同じく planH - 0.1 まで詰める。
      //   （🌸は「初心者マーク」であり、必要人数に数えないだけで労働時間の扱いは他と同じ）
      let guard9 = 0;
      while ((staffHours[s.id]||0) < planH - 0.1 && guard9++ < daysInMonth + 5) {
        let placed = false;
        for (let d = 1; d <= daysInMonth; d++) {
          const key = `${s.id}|${d}`;
          if (result[key] !== '休み') continue;
          if (lockedCells[key]) continue;
          const dt9 = getDayType(d);
          if (dt9 === 'thu_closed' || dt9 === 'holiday_closed' || dt9 === 'clinic_closed') continue;
          // 【修正】土日祝は診療日のため一律除外を撤廃。土日連勤のみ抑止。
          if (wouldCauseWeekendConsec(s.id, d)) continue;

          // 通常水曜は午前のみ診療 → 午後をカバーしないシフトを使う
          const sh9 = s.emp_type === 'short' ? '時短'
            : (dt9 === 'wed_cc' ? 'CC' : dt9 === 'wed_cho' ? 'CHO' : dt9 === 'wed_normal' ? '午前' : '日勤');
          // 所定時間 +2H を超える配置はしない（STEP8と同じ許容幅）
          if ((staffHours[s.id]||0) + (SHIFT_HOURS[sh9]||0) > planH + 2) continue;
          result[key] = sh9;
          staffHours[s.id] = (staffHours[s.id]||0) + (SHIFT_HOURS[sh9]||0);
          placed = true;
          break;
        }
        if (!placed) break;
      }
    });

    // 時短スタッフの強制修正
    deptStaff.forEach(staff => {
      if (staff.emp_type !== 'short') return;
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${staff.id}|${d}`;
        if (lockedCells[key]) continue;
        const shift = result[key];
        if (!shift) continue;
        if (['時短','CC','CCのみ','CHO','休み','有休','半有休','個夏休','希望休'].includes(shift)) continue;
        const dt = getDayType(d);
        result[key] = dt === 'wed_cc' ? 'CC' : dt === 'wed_cho' ? 'CHO' : '時短';
      }
    });

    _logStep('STEP9完了');

    // ===== STEP10: 休みの均等化（週次 × 日別を同時最適化）=====
    // 背景:
    //   STEP6/8 は 1日目から順に埋めるため所定労働時間が先着順で消費され、月後半に休みが集中する。
    //   さらに全スタッフが同じ順序で日を選ぶため、休みが同一日に積み上がる。
    // 方針:
    //   「日別の休み人数のばらつき」＋「各人の週別休み比率のばらつき」を合成したコストを定義し、
    //   同一スタッフ内の（休み ⇄ 勤務）交換のうち、コストを最も下げる1手を繰り返し適用する。
    //   逐次スワップ（片方だけを見る貪欲法）は局所最適で止まるため、両者を同時に評価する。
    // 不変条件:
    //   同一スタッフ内でシフト種別ごと移動するため 総労働時間・シフト構成は変化しない。
    //   ロック / 希望休・有休 / 希望勤務 / 必要人数 / 曜日タイプ / 時短・夜勤属性 / 土日連勤 を壊さない。
    {
      const firstDow = new Date(genYear, genMonth - 1, 1).getDay();
      const weekOf = (d) => Math.floor((d + firstDow - 1) / 7);

      // 稼働日（休診日を除く）だけを均等化の対象にする
      const openDays = [];
      for (let d = 1; d <= daysInMonth; d++) if (!isClosedDay(d)) openDays.push(d);
      if (openDays.length >= 2) {

      const weekDays = {};
      openDays.forEach(d => { const w = weekOf(d); (weekDays[w] = weekDays[w] || []).push(d); });
      const weekKeys = Object.keys(weekDays).map(Number).sort((a, b) => a - b)
        .filter(w => weekDays[w].length >= 3); // 端数週は週次評価から除外

      // 均等化の対象スタッフ（所定0Hのみ除外）
      // 🌸スタッフ（初心者マーク）も含める。必要人数に数えないだけで、労働者としての扱いは同じ。
      //   ただし日別の休み人数(offOnDay)には寄与させない＝「人数に数えない」原則は維持し、
      //   各人の週別の偏り(offInWeek)だけを均等化する。
      const targets = deptStaff.filter(s => getStaffPlanHours(s) > 0);

      // その日の休み人数（🌸は人数カウント外）
      const offCountOnDay = (d) => deptStaff.filter(s =>
        !isNoCount(s) && OFF_SHIFTS.includes(result[`${s.id}|${d}`])
      ).length;

      // --- コスト関数（差分計算） ---
      // コスト = Σ_日(休み人数)^2  +  WEEK_WEIGHT × Σ_人Σ_週(週の休み比率)^2
      //   いずれも「二乗和」なので、値が特定の日/週に偏るほど大きくなる＝分散の最小化と同義。
      //   全体を数え直すと O(日×人) が毎回走り実用に耐えない（実測70秒）。
      //   交換で変化するのは「od日・wd日の休み人数」と「その人の該当2週の休み数」だけなので、
      //   その差分のみを評価する（実測77ms・約900倍）。
      const WEEK_WEIGHT = 10;
      const weekSet = new Set(weekKeys);

      // インクリメンタルに保持する集計
      const offOnDay = {};
      openDays.forEach(d => { offOnDay[d] = offCountOnDay(d); });
      const offInWeek = {};
      targets.forEach(s => {
        offInWeek[s.id] = {};
        weekKeys.forEach(w => {
          offInWeek[s.id][w] = weekDays[w].filter(d => OFF_SHIFTS.includes(result[`${s.id}|${d}`])).length;
        });
      });

      const dayTerm = (n) => n * n;
      const weekTerm = (w, n) => { const r = n / weekDays[w].length; return r * r * WEEK_WEIGHT; };

      // 🌸は日別の休み人数にカウントされない（＝日別コストに寄与しない）
      const countsForDay = {};
      targets.forEach(s => { countsForDay[s.id] = !isNoCount(s); });

      // od(休み→勤務) / wd(勤務→休み) に入れ替えたときのコスト減少量
      const gainOf = (sid, od, wd) => {
        let delta = 0;
        if (countsForDay[sid]) {  // 🌸以外のみ日別コストへ寄与
          delta += dayTerm(offOnDay[od] - 1) - dayTerm(offOnDay[od]);
          delta += dayTerm(offOnDay[wd] + 1) - dayTerm(offOnDay[wd]);
        }
        const wo = weekOf(od), ww = weekOf(wd);
        if (weekSet.has(wo)) { const n = offInWeek[sid][wo]; delta += weekTerm(wo, n - 1) - weekTerm(wo, n); }
        if (weekSet.has(ww)) { const n = offInWeek[sid][ww]; delta += weekTerm(ww, n + 1) - weekTerm(ww, n); }
        return -delta; // 正なら改善
      };

      // 交換を確定し、集計を更新
      const applySwap = (sid, od, wd, sh) => {
        result[`${sid}|${od}`] = sh;
        result[`${sid}|${wd}`] = '休み';
        // 🌸は offCountOnDay に含まれないため、日別集計も更新しない（整合を保つ）
        if (countsForDay[sid]) { offOnDay[od]--; offOnDay[wd]++; }
        const wo = weekOf(od), ww = weekOf(wd);
        if (weekSet.has(wo)) offInWeek[sid][wo]--;
        if (weekSet.has(ww)) offInWeek[sid][ww]++;
      };

      // --- 交換可否の判定 ---
      // 動かせる「休み」= '休み' のみ（有休・希望休・ロックは不可侵）
      const movableOff = (sid, d) =>
        !lockedCells[`${sid}|${d}`] && result[`${sid}|${d}`] === '休み';

      // 動かせる「勤務」= ロック外かつ希望勤務でない
      const movableWork = (sid, d) => {
        const key = `${sid}|${d}`;
        if (lockedCells[key]) return false;
        const sh = result[key];
        if (!sh || OFF_SHIFTS.includes(sh)) return false;
        if (reqMap[key] && reqMap[key] !== '希望休') return false;
        return true;
      };

      // その日の勤務を抜いても必要人数を割らないか
      const canRemoveWork = (sid, d) => {
        const sh = result[`${sid}|${d}`];
        if (!sh) return false;
        // 🌸は countCoverage に含まれない＝抜いても充足数は減らないので、人数制約を課さない。
        //   （旧実装は一律 -1 していたため、🌸の移動が不当にブロックされていた）
        if (!countsForDay[sid]) return true;
        for (const period of ['morning', 'afternoon', 'evening']) {
          if (!SHIFT_COVERS[sh]?.includes(period)) continue;
          const req = getRequired(period, d);
          if (req == null || req <= 0) continue; // 未設定/明示ゼロ → 人数制約なし
          if (countCoverage(deptStaff, d, period) - 1 < req) return false;
        }
        return true;
      };

      // その日にそのシフトを置けるか（曜日タイプ・属性・土日連勤）
      const canPlaceWork = (staff, d, sh) => {
        if (isClosedDay(d)) return false;
        const dt = getDayType(d);
        if (dt === 'wed_cc' && !['CC', 'CCのみ'].includes(sh)) return false;
        if (dt === 'wed_cho' && sh !== 'CHO') return false;
        if (dt === 'wed_normal' && !['午前', '時短'].includes(sh)) return false;
        if (dt !== 'wed_cc' && ['CC', 'CCのみ'].includes(sh)) return false;
        if (dt !== 'wed_cho' && sh === 'CHO') return false;
        if (staff.emp_type === 'short' && !['時短', 'CC', 'CCのみ', 'CHO'].includes(sh)) return false;
        if (staff.emp_type !== 'short' && sh === '時短') return false;
        if (isNoNightAuto(staff) && NIGHT_SHIFTS.includes(sh)) return false;
        if (wouldCauseWeekendConsec(staff.id, d)) return false;
        return true;
      };

      // --- 貪欲改善: コストを最も下げる交換を1手ずつ適用 ---
      // 反復上限は規模に応じて調整（計算量 O(iter × staff × offDays × workDays)）
      const MAX_ITER = Math.min(300, openDays.length * 6);
      for (let iter = 0; iter < MAX_ITER; iter++) {
        let best = null, bestGain = 1e-9; // 微小改善は無視して収束させる

        for (const s of targets) {
          const offs = openDays.filter(d => movableOff(s.id, d));
          if (!offs.length) continue;
          const works = openDays.filter(d => movableWork(s.id, d));
          if (!works.length) continue;

          for (const wd of works) {
            const sh = result[`${s.id}|${wd}`];
            if (!canRemoveWork(s.id, wd)) continue;
            for (const od of offs) {
              // 差分でコスト改善量を先に見る（重い制約チェックの前に足切り）
              const gain = gainOf(s.id, od, wd);
              if (gain <= bestGain) continue;

              // 【重要】判定は必ず「交換後の状態」で行う。
              //   交換前に判定すると、例えば「土曜勤務・日曜休み」の人が日曜へ移れない。
              //   （土曜がまだ勤務なので土日連勤と誤判定され、日曜が永久に全員休みになる）
              //   実際に入れ替えてから曜日タイプ・属性・土日連勤を検証し、必ず巻き戻す。
              const bkOff = result[`${s.id}|${od}`];
              const bkWork = result[`${s.id}|${wd}`];
              result[`${s.id}|${od}`] = sh;
              result[`${s.id}|${wd}`] = '休み';
              const ok = canPlaceWork(s, od, sh);
              result[`${s.id}|${od}`] = bkOff;
              result[`${s.id}|${wd}`] = bkWork;
              if (!ok) continue;

              bestGain = gain; best = { sid: s.id, od, wd, sh };
            }
          }
        }

        if (!best) break; // これ以上コストを下げられない＝収束
        applySwap(best.sid, best.od, best.wd, best.sh);
      }

      }
    }
    _logStep('STEP10完了（休みの均等化：週次×日別の同時最適化）');

    // 充足状況サマリーを生成
    const _coverageSummary = [];
    let _shortageDays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dt_chk = getDayType(d);
      if (dt_chk === 'thu_closed' || dt_chk === 'holiday_closed' || dt_chk === 'clinic_closed') continue;
      for (const period of ['morning','afternoon','evening']) {
        const req = getRequired(period, d);
        if (!req || req <= 0) continue;
        const cov = deptStaff.filter(s => {
          if (isNoCount(s)) return false;
          const sh = result[`${s.id}|${d}`];
          return sh && SHIFT_COVERS[sh]?.includes(period);
        }).length;
        if (cov < req) {
          _shortageDays++;
          _coverageSummary.push(`${d}日 ${period}: ${cov}/${req} 不足`);
        } else if (cov > req) {
          _coverageSummary.push(`${d}日 ${period}: ${cov}/${req} 超過`);
        }
      }
    }
    // 土日連勤の発生件数チェック
    const _weekendConsecList = [];
    for (let d = 1; d < daysInMonth; d++) {
      const dow = new Date(genYear, genMonth-1, d).getDay();
      if (dow !== 6) continue;
      // d=土曜、d+1=日曜
      deptStaff.forEach(s => {
        const sat = result[`${s.id}|${d}`];
        const sun = result[`${s.id}|${d+1}`];
        if (sat && !OFF_SHIFTS.includes(sat) && sun && !OFF_SHIFTS.includes(sun)) {
          _weekendConsecList.push(`${s.name}: ${d}(土)${sat} → ${d+1}(日)${sun}`);
        }
      });
    }
    console.log('[自動生成] STEP別ログ', _genLog);
    console.log('[自動生成] 充足課題', _coverageSummary.length === 0 ? '完全充足' : _coverageSummary);
    console.log('[自動生成] 土日連勤', _weekendConsecList.length === 0 ? 'なし' : _weekendConsecList);
    console.log('[自動生成] スタッフ別最終時間',
      deptStaff.map(s => ({
        名前: s.name,
        実績: (staffHours[s.id]||0).toFixed(1) + 'h',
        所定: getStaffPlanHours(s) + 'h',
        差分: ((staffHours[s.id]||0) - getStaffPlanHours(s)).toFixed(1) + 'h',
        夜勤: `${staffNightCount[s.id]||0}/${getStaffMaxNight(s)}`,
        遅番: `${staffLateCount[s.id]||0}/${getStaffMaxLate(s)}`,
        長日: `${staffLongCount[s.id]||0}/${getStaffMaxLong(s)}`,
        中抜け: `${staffMidCount[s.id]||0}/${getStaffMaxMid(s)}`,
        雇用形態: s.emp_type || 'full',
        能力: s.skill_level || 'normal'
      }))
    );

    // ===== 精度スコアの算出と表示（フェーズ1：可視化）=====
    // あなたの5要件のうち、まず「測れる」ものを数値化する。
    //   ①必要人数の充足率  ②所定労働時間の達成率
    //   ③希望休の反映率（絶対要件）  ④希望勤務の反映率（絶対要件・正当な却下は理由付きで一覧）
    // これにより「今何%か」「どの希望が・なぜ通らなかったか」が一目で分かり、手動修正の照準が定まる。
    {
      // --- ① 必要人数の充足率（人日ベース。🌸は数えない） ---
      let reqTotal = 0, reqCovered = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const dtc = getDayType(d);
        if (dtc === 'thu_closed' || dtc === 'holiday_closed' || dtc === 'clinic_closed') continue;
        for (const period of ['morning', 'afternoon', 'evening']) {
          const req = getRequired(period, d);
          if (!req || req <= 0) continue;
          reqTotal += req;
          const cov = deptStaff.filter(s => {
            if (isNoCount(s)) return false;
            const sh = result[`${s.id}|${d}`];
            return sh && SHIFT_COVERS[sh]?.includes(period);
          }).length;
          reqCovered += Math.min(cov, req);
        }
      }
      const fillRate = reqTotal > 0 ? Math.round(reqCovered / reqTotal * 100) : 100;

      // --- ② 所定労働時間の達成率（±2H以内を達成とみなす。🌸含む） ---
      const hoursStaff = deptStaff.filter(s => getStaffPlanHours(s) > 0);
      const hoursOk = hoursStaff.filter(s => {
        const plan = getStaffPlanHours(s);
        return Math.abs((staffHours[s.id] || 0) - plan) <= 2;
      }).length;
      const hoursRate = hoursStaff.length > 0 ? Math.round(hoursOk / hoursStaff.length * 100) : 100;

      // --- ③④ 希望の反映率（reqMap を正解データとして突合） ---
      let offReqTotal = 0, offReqOk = 0;       // 希望休
      let workReqTotal = 0, workReqOk = 0;     // 希望勤務
      const rejected = [];                      // 通らなかった希望勤務（理由付き）
      const staffById = {};
      deptStaff.forEach(s => { staffById[s.id] = s; });
      for (const key in reqMap) {
        const req = reqMap[key];
        if (!req) continue;
        const [sid, dStr] = key.split('|');
        if (!staffById[sid]) continue; // 別部門などは無視
        const placed = result[key];
        if (OFF_SHIFTS.includes(req)) {
          // 希望休（絶対要件）
          offReqTotal++;
          if (placed && OFF_SHIFTS.includes(placed)) offReqOk++;
          else rejected.push({ name: staffById[sid].name, day: dStr, want: req, got: placed || '未配置', kind: 'off' });
        } else {
          // 希望勤務（絶対要件・ただし所定+2H超過/土日連勤/診療日整合は正当な却下）
          workReqTotal++;
          if (placed === req) workReqOk++;
          else rejected.push({ name: staffById[sid].name, day: dStr, want: req, got: placed || '未配置', kind: 'work' });
        }
      }
      const offRate = offReqTotal > 0 ? Math.round(offReqOk / offReqTotal * 100) : 100;
      const workRate = workReqTotal > 0 ? Math.round(workReqOk / workReqTotal * 100) : 100;

      // --- 総合精度（絶対要件の希望を重めに重み付け） ---
      // 重み: 希望休30 / 希望勤務25 / 必要人数25 / 所定時間20
      const overall = Math.round(
        (offRate * 30 + workRate * 25 + fillRate * 25 + hoursRate * 20) / 100
      );

      // コンソールにも詳細を出す（デバッグ・検証用）
      console.log('[精度スコア]', { overall, 希望休: offRate, 希望勤務: workRate, 必要人数: fillRate, 所定時間: hoursRate });
      if (rejected.length) console.log('[通らなかった希望]', rejected);

      // グローバルに退避（プレビューカード描画時に表示する）
      window._genPrecision = {
        overall, fillRate, hoursRate, offRate, workRate,
        offReqOk, offReqTotal, workReqOk, workReqTotal, reqCovered, reqTotal, hoursOk, hoursTotal: hoursStaff.length,
        rejected, shortageDays: _shortageDays, weekendConsec: _weekendConsecList.length,
      };
    }

    // ★ AI 生成プレビュー：生成前のメモリ状態をスナップショット
    //   「生成前に戻す」ボタンで完全復元できるようにする。
    //   shiftData/lockedCells は次の行から AI 結果で上書きされるため、その直前に退避。
    preAIGenerationSnapshot = {
      shiftData: JSON.parse(JSON.stringify(shiftData)),
      lockedCells: JSON.parse(JSON.stringify(lockedCells)),
      shiftYear,
      shiftMonth
    };

    // 生成結果を保存
    generatedShifts = result;

    // shiftDataを完全リセット（DBからの再読み込みはしない）
    shiftYear = genYear;
    shiftMonth = genMonth;
    shiftData = {};
    lockedCells = {};

    // 生成結果をshiftDataに設定
    // ★ ロック済み未選択セルは result[key] = '' で入っているため、空文字はshiftDataに入れない
    //   （空文字をshiftDataに入れると「シフトあり」と誤解釈され、未選択表示が崩れる）
    Object.entries(result).forEach(([key, shift]) => {
      if (shift !== '') shiftData[key] = shift;
    });
    // ロック済みセルを設定
    Object.entries(lockMap).forEach(([key]) => {
      lockedCells[key] = true;
    });

    // シフト表タブに切り替え
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelector('.nav-item[data-page="shift"]')?.classList.add('active');
    document.getElementById('page-shift')?.classList.add('active');

    // ★ AI 生成プレビュー承認バナーを表示
    //   ユーザーが「確定」または「生成前に戻す」を押すまで表示し続ける。
    //   他の設定操作は preFlightCheck で自動ブロックされる。
    const previewBanner = document.getElementById('aiPreviewBanner');
    if (previewBanner) previewBanner.style.display = 'block';

    // 精度スコアカードを表示（フェーズ1：可視化）
    if (window._genPrecision) renderPrecisionCard(window._genPrecision);

    // DB再読み込みせずグリッドのみ再描画
    const reqMapForRender = {};
    requests.forEach(r => { reqMapForRender[`${r.staff_id}|${r.day}`] = r.request_type; });

    // シフトグリッドの変数を設定
    shiftGridRequirements = {};
    requirements.forEach(r => {
      if (!shiftGridRequirements[r.period_id]) shiftGridRequirements[r.period_id] = {};
      shiftGridRequirements[r.period_id][r.day_type] = r.min_count;
    });
    shiftGridPlanHours = monthlyHoursData.length > 0 ? monthlyHoursData[0].hours : 160;
    shiftGridStaffSettings = {};
    staffSettingsData.forEach(s => { shiftGridStaffSettings[s.staff_id] = s; });

    // window変数を設定（getShiftDayType用）
    window._shiftClosedHolidays = closedHolidays;
    window._shiftOpenThursdays = openThursdays;
    window._shiftCustomClosed = customClosedDays ? Object.fromEntries(Array.from(customClosedDays).map(d => [d, '休診'])) : {};
    // タブ切替時の状態保持・希望マーク表示用
    window._shiftReqMap = reqMapForRender;
    window._shiftWedTypes = wedTypes;

    // 水曜タイプを設定（wedTypesは自動生成ページで既に読み込み済み）
    shiftWedTypes = { ...wedTypes };

    // グリッドを描画
    renderShiftGrid('shiftGrid', deptStaff, daysInMonth, genYear, genMonth, shiftData, reqMapForRender, lockedCells, true, shiftWedTypes);
    refreshSummaryRows();

    // タブ切替時に保持されるようにcontextと保存スナップショットを更新
    // ※shiftYear/shiftMonthを生成対象月に合わせる（自動生成後にシフト表月をズレないように）
    shiftYear = genYear;
    shiftMonth = genMonth;
    updateMonthDisplays();
    shiftGridContext = `${currentDept}|${shiftYear}|${shiftMonth}`;
    savedShiftSnapshot = {
      shiftData: JSON.parse(JSON.stringify(shiftData)),
      lockedCells: JSON.parse(JSON.stringify(lockedCells)),
      cellLabels: JSON.parse(JSON.stringify(cellLabels))
    };
    undoStack = [];
    redoStack = [];

    document.getElementById('page-shift')?.scrollIntoView({ behavior:'smooth' });
    showToast('自動生成完了 ✓ シフト表で編集できます', 'success');

  } catch(e) { console.error(e); showToast('生成エラー: ' + e.message,'error'); }
  hideLoading();
});

function selectDayShift(period, deptId, dayType, enabledPatterns) {
  const ep = enabledPatterns || SHIFT_PATTERN_OPTIONS.map(s => s.id);
  if (period === 'morning') {
    if (dayType === 'wed_cc') return 'CC';
    if (dayType === 'wed_cho') return 'CHO';
    // 通常水曜は午前のみ診療 → 午後をカバーする「日勤/日勤+」ではなく「午前」を使う
    if (dayType === 'wed_normal') {
      for (const sh of ['午前','日勤','日勤+']) {
        if (ep.includes(sh)) return sh;
      }
      return '午前';
    }
    // 午前：日勤 → 日勤+ → 午前 の順で有効なもの
    for (const sh of ['日勤','日勤+','午前']) {
      if (ep.includes(sh)) return sh;
    }
    return '日勤';
  }
  if (period === 'afternoon') {
    if (dayType === 'wed_cc') return 'CCのみ';
    if (dayType === 'wed_cho') return null;
    if (dayType === 'wed_normal') return null; // 通常水曜の午後は診療なし
    if (deptId === 2) return ep.includes('リハ遅') ? 'リハ遅' : null;
    // 午後：遅番 → 遅L → 長日 の順で有効なもの
    for (const sh of ['遅番','遅L','長日']) {
      if (ep.includes(sh)) return sh;
    }
    return null;
  }
  return '日勤';
}

function selectEveningShiftWithPattern(deptId, dayType, enabledPatterns) {
  const ep = enabledPatterns || SHIFT_PATTERN_OPTIONS.map(s => s.id);
  if (deptId === 2) return ep.includes('リハ遅') ? 'リハ遅' : null;
  if (deptId === 1) return ep.includes('遅番') ? '遅番' : null;
  // 遅番 → 遅L → 夜勤 → 長日 → 中抜けの順
  for (const sh of ['遅番','遅L','夜勤','長日','中抜け']) {
    if (ep.includes(sh)) return sh;
  }
  return null;
}

function selectEveningShift(deptId, dayType) {
  if (deptId === 2) return 'リハ遅';
  if (deptId === 1) return '遅番';
  // 医療事務・放射線：遅番を優先、必要人数が足りない場合に夜勤
  return '遅番';
}

function renderPrecisionCard(p) {
  const card = document.getElementById('previewCard');
  if (!card) return;
  const old = document.getElementById('generateSummary');
  if (old) old.remove();

  const colorOf = (r) => r >= 95 ? '#059669' : r >= 85 ? '#d97706' : '#dc2626';
  const bgOf = (r) => r >= 95 ? '#d1fae5' : r >= 85 ? '#fef3c7' : '#fee2e2';

  // 個別指標のミニバッジ
  const metric = (label, rate, sub) => `
    <div style="display:flex;align-items:center;gap:8px">
      <div style="font-size:22px;font-weight:800;color:${colorOf(rate)}">${rate}%</div>
      <div>
        <div style="font-size:11px;font-weight:700;color:#374151">${label}</div>
        <div style="font-size:10px;color:#9ca3af">${sub}</div>
      </div>
    </div>`;

  // 通らなかった希望の一覧（希望休の未達は最優先で赤、希望勤務は理由の可能性を添える）
  let rejectHtml = '';
  if (p.rejected && p.rejected.length) {
    const offMiss = p.rejected.filter(r => r.kind === 'off');
    const workMiss = p.rejected.filter(r => r.kind === 'work');
    const rows = [];
    offMiss.forEach(r => rows.push(`<span style="color:#dc2626;font-weight:700">⚠️ ${r.name} ${r.day}日: 希望休が未反映（現在: ${r.got}）</span>`));
    workMiss.forEach(r => rows.push(`<span style="color:#92400e">${r.name} ${r.day}日: 希望勤務「${r.want}」未反映（現在: ${r.got}）</span>`));
    rejectHtml = `
      <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border)">
        <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:4px">通らなかった希望（${p.rejected.length}件）</div>
        <div style="font-size:11px;line-height:1.7;max-height:140px;overflow-y:auto">${rows.join('<br>')}</div>
        <div style="font-size:10px;color:#9ca3af;margin-top:4px">※希望勤務の未反映は、所定+2H超過／土日連勤／CC・CHO日の種別不一致が主因です</div>
      </div>`;
  }

  const summary = document.createElement('div');
  summary.id = 'generateSummary';
  summary.style.cssText = 'margin-bottom:16px';
  summary.innerHTML = `
    <div style="background:${bgOf(p.overall)};border-radius:14px;padding:16px 20px">
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="font-size:34px;font-weight:900;color:${colorOf(p.overall)}">${p.overall}%</div>
          <div style="font-size:12px;font-weight:700;color:${colorOf(p.overall)}">総合精度</div>
        </div>
        <div style="width:1px;height:44px;background:var(--border)"></div>
        <div style="display:flex;gap:18px;flex-wrap:wrap">
          ${metric('希望休', p.offRate, `${p.offReqOk}/${p.offReqTotal}件`)}
          ${metric('希望勤務', p.workRate, `${p.workReqOk}/${p.workReqTotal}件`)}
          ${metric('必要人数', p.fillRate, `${p.reqCovered}/${p.reqTotal}人日`)}
          ${metric('所定時間', p.hoursRate, `${p.hoursOk}/${p.hoursTotal}人`)}
        </div>
      </div>
      ${rejectHtml}
    </div>`;

  const titleEl = card.querySelector('.card-title');
  if (titleEl) titleEl.insertAdjacentElement('afterend', summary);
  else card.prepend(summary);
}

// 祝日（2026年簡易版）

// ===== AI 生成プレビューの確定／破棄ロジック（共通関数化） =====

// 「確定」処理：生成結果を DB に保存して、編集モードに移行
async function approveAIPreview() {
  if (Object.keys(generatedShifts).length === 0) {
    showToast('プレビュー対象がありません', 'error');
    return;
  }
  const monthLabel = `${shiftYear}年${shiftMonth}月`;
  const deptLabel = DEPT_NAMES[currentDept] || `部署${currentDept}`;
  if (!confirm(`【確認】${deptLabel}・${monthLabel}のシフトを自動生成結果で確定します。\n\n・現在 DB に保存されているシフトは自動生成結果に置き換わります。\n・「ロック済み」のシフトはそのまま残ります。\n\nよろしいですか？`)) {
    showToast('確定をキャンセルしました');
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
    // ★ 空シフトは保存しない。ロックは lockedCells から再構築。アルバイト氏名(cellLabels)も保全。
    const staffIds = deptStaff.map(s => s.id);
    const insKeys = new Set([...Object.keys(generatedShifts).filter(k => generatedShifts[k] !== ''), ...Object.keys(cellLabels)]);
    const inserts = [];
    insKeys.forEach(key => {
      const shiftId = generatedShifts[key] || null;
      const label = cellLabels[key] || null;
      if (!shiftId && !label) return;
      const [staffId, day] = parseKey(key);
      inserts.push({ staff_id: staffId, day: parseInt(day), shift_type_id: shiftId, is_locked: !!lockedCells[key], cell_label: label });
    });
    if (staffIds.length) {
      await adminApi('/api/data', { action:'save-shift-month', year:shiftYear, month:shiftMonth, staff_ids:staffIds, confirmed:false, rows:inserts, cellLocks:buildCellLockRows() });
    }

    // shiftData は既に AI 結果で上書き済み。再度同期しておく。
    shiftData = {};
    Object.entries(generatedShifts).forEach(([key, shift]) => {
      if (shift !== '') shiftData[key] = shift;
    });

    // 保存時点スナップショット更新（保存ボタンと同じ）
    savedShiftSnapshot = {
      shiftData: JSON.parse(JSON.stringify(shiftData)),
      lockedCells: JSON.parse(JSON.stringify(lockedCells))
    };
    undoStack = [];
    redoStack = [];

    // プレビュー状態をクリア
    generatedShifts = {};
    preAIGenerationSnapshot = null;

    // バナーと旧プレビューカードを非表示
    const banner = document.getElementById('aiPreviewBanner');
    if (banner) banner.style.display = 'none';
    const card = document.getElementById('previewCard');
    if (card) card.style.display = 'none';

    showToast('自動生成結果を確定し、編集モードに移行しました ✓','success');
  } catch(e) {
    console.error(e);
    showToast('確定エラー','error');
  }
  hideLoading();
}

// 「生成前に戻す」処理：スナップショットからメモリを完全復元（DB は触らない）
async function discardAIPreview() {
  if (!preAIGenerationSnapshot && Object.keys(generatedShifts).length === 0) {
    showToast('破棄対象がありません', 'error');
    return;
  }

  // プレビュー状態をクリア
  generatedShifts = {};

  if (preAIGenerationSnapshot) {
    // メモリスナップショットから完全復元（DB は触らない）
    shiftData = JSON.parse(JSON.stringify(preAIGenerationSnapshot.shiftData));
    lockedCells = JSON.parse(JSON.stringify(preAIGenerationSnapshot.lockedCells));
    shiftYear = preAIGenerationSnapshot.shiftYear;
    shiftMonth = preAIGenerationSnapshot.shiftMonth;
    preAIGenerationSnapshot = null;
    // 画面を再描画
    rerenderShiftGridFromMemory();
    showToast('自動生成前の状態に戻しました');
  } else {
    // フォールバック：スナップショットが無ければ DB から再取得
    showLoading();
    try {
      await loadShiftGrid();
    } finally {
      hideLoading();
    }
    showToast('自動生成結果を破棄しました');
  }

  // バナーと旧プレビューカードを非表示
  const banner = document.getElementById('aiPreviewBanner');
  if (banner) banner.style.display = 'none';
  const card = document.getElementById('previewCard');
  if (card) card.style.display = 'none';
}

// ===== 旧来の「自動生成」タブ内のボタン（後方互換）=====
document.getElementById('applyGenerateBtn').addEventListener('click', approveAIPreview);
document.getElementById('discardGenerateBtn').addEventListener('click', discardAIPreview);

// ===== シフト表上の新バナーボタン =====
document.getElementById('aiPreviewApproveBtn')?.addEventListener('click', approveAIPreview);
document.getElementById('aiPreviewDiscardBtn')?.addEventListener('click', discardAIPreview);
