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
        const mReq = getRequired('morning', d) || 0;
        const aReq = getRequired('afternoon', d) || 0;
        const eReq = getRequired('evening', d) || 0;

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
        const dow = new Date(genYear, genMonth-1, d).getDay();
        const dt2 = getDayType(d);
        // 日曜・休診日は休み（時短スタッフでも）
        if (dow === 0 || dt2 === 'thu_closed' || dt2 === 'holiday_closed' || dt2 === 'clinic_closed') {
          result[key] = '休み';
          continue;
        }
        // 土曜：常勤・パートは休み、時短は必要人数を超えない範囲で勤務可
        if (dow === 6) {
          if (staff.emp_type === 'short' && (staffHours[staff.id]||0) + SHIFT_HOURS['時短'] <= planH + 2) {
            // 土曜の午前必要人数を確認（超過しないように）
            const satMReq = getRequired('morning', d) || 0;
            const satMCov = countCoverage(deptStaff, d, 'morning');
            if (satMCov < satMReq + 1) {
              result[key] = '時短';
              staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS['時短']||0);
              continue;
            }
          }
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
            const ccReq = getRequired('morning', d) || 0;
            const ccCov = countCoverage(deptStaff, d, 'morning');
            if (ccCov < ccReq + 1 && (staffHours[staff.id]||0) + SHIFT_HOURS[ccShift] <= planH + 2) {
              result[key] = ccShift;
              staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS[ccShift]||0);
              continue;
            }
            result[key] = '休み';
            continue;
          }
          if (dt2 === 'wed_cho') {
            const choShift = 'CHO';
            const choReq = getRequired('morning', d) || 0;
            const choCov = countCoverage(deptStaff, d, 'morning');
            if (choCov < choReq + 1 && (staffHours[staff.id]||0) + SHIFT_HOURS[choShift] <= planH + 2) {
              result[key] = choShift;
              staffHours[staff.id] = (staffHours[staff.id]||0) + (SHIFT_HOURS[choShift]||0);
              continue;
            }
            result[key] = '休み';
            continue;
          }
          if (dt2 === 'wed_normal') {
            // 水曜通常は時短スタッフも休み
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
        // 常勤・パート: CC/CHO日・水曜通常は休み
        if (dt2 === 'wed_normal' || dt2 === 'wed_cc' || dt2 === 'wed_cho') {
          result[key] = '休み';
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
          const dow8 = new Date(genYear, genMonth-1, d).getDay();
          // 日曜は休み、土曜は時短スタッフのみ対象
          if (dow8 === 0) continue;
          if (dow8 === 6 && s.emp_type !== 'short') continue;
          if (dt8 === 'wed_normal') continue;

          // スコアリングで最適シフトを選択
          const candidates8 = (enabledPatterns.length > 0 ? enabledPatterns : ['日勤'])
            .filter(sh => {
              // CC/CHO日の制限
              if (dt8 === 'wed_cc' && !['CC','CCのみ'].includes(sh)) return false;
              if (dt8 === 'wed_cho' && sh !== 'CHO') return false;
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
      let guard9 = 0;
      while ((staffHours[s.id]||0) < planH - 2 && guard9++ < daysInMonth + 5) {
        let placed = false;
        for (let d = 1; d <= daysInMonth; d++) {
          const key = `${s.id}|${d}`;
          if (result[key] !== '休み') continue;
          if (lockedCells[key]) continue;
          const dt9 = getDayType(d);
          if (dt9 === 'thu_closed' || dt9 === 'holiday_closed' || dt9 === 'clinic_closed') continue;
          const dow9 = new Date(genYear, genMonth-1, d).getDay();
          if (dow9 === 0 || dow9 === 6) continue;
          if (dt9 === 'wed_normal') continue;

          const need9 = planH - (staffHours[s.id]||0);
          const sh9 = s.emp_type === 'short' ? '時短' : (dt9 === 'wed_cc' ? 'CC' : dt9 === 'wed_cho' ? 'CHO' : '日勤');
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
    // 午前：日勤 → 日勤+ → 午前 の順で有効なもの
    for (const sh of ['日勤','日勤+','午前']) {
      if (ep.includes(sh)) return sh;
    }
    return '日勤';
  }
  if (period === 'afternoon') {
    if (dayType === 'wed_cc') return 'CCのみ';
    if (dayType === 'wed_cho') return null;
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

function showGenerateSummary(deptStaff, result, staffHours, staffNightCount, daysInMonth, getStaffPlanHours, getRequired) {
  let totalRequired = 0, totalCovered = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    ['morning','afternoon','evening'].forEach(period => {
      const req = getRequired(period, d);
      if (!req || req === 0) return;
      totalRequired += req;
      const covered = deptStaff.filter(s => {
        if (s.skill_level === 'no_count' || s.no_count === true) return false;
        const shift = result[`${s.id}|${d}`];
        return shift && SHIFT_COVERS[shift]?.includes(period);
      }).length;
      totalCovered += Math.min(covered, req);
    });
  }
  const hoursOk = deptStaff.filter(s => {
    const plan = getStaffPlanHours(s);
    if (plan <= 0) return true;
    return (staffHours[s.id]||0) >= plan * 0.95;
  }).length;
  const fillRate = totalRequired > 0 ? Math.round(totalCovered / totalRequired * 100) : 100;
  const card = document.getElementById('previewCard');
  const existing = document.getElementById('generateSummary');
  if (existing) existing.remove();
  const summary = document.createElement('div');
  summary.id = 'generateSummary';
  summary.style.cssText = 'margin-bottom:16px';
  const fillColor = fillRate>=100 ? '#065f46' : '#92400e';
  const fillBg = fillRate>=100 ? '#d1fae5' : '#fef3c7';
  const hoursColor = hoursOk===deptStaff.length ? '#065f46' : '#92400e';
  summary.innerHTML = `
    <div style="background:${fillBg};border-radius:12px;padding:14px 18px;display:flex;gap:24px;align-items:center;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="font-size:28px;font-weight:800;color:${fillColor}">${fillRate}%</div>
        <div>
          <div style="font-size:12px;font-weight:600;color:${fillColor}">必要人数充足率</div>
          <div style="font-size:11px;color:var(--text-muted)">${totalCovered}/${totalRequired} 人日</div>
        </div>
      </div>
      <div style="width:1px;height:40px;background:var(--border)"></div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="font-size:28px;font-weight:800;color:${hoursColor}">${hoursOk}/${deptStaff.length}</div>
        <div>
          <div style="font-size:12px;font-weight:600;color:${hoursColor}">所定時間達成</div>
          <div style="font-size:11px;color:var(--text-muted)">95%以上</div>
        </div>
      </div>
      <div style="width:1px;height:40px;background:var(--border)"></div>
      <div style="font-size:12px;color:var(--text-muted);line-height:1.8">
        ${deptStaff.map(s => {
          const plan = getStaffPlanHours(s);
          const actual = Math.round((staffHours[s.id]||0)*10)/10;
          const rate = plan>0 ? Math.round(actual/plan*100) : 100;
          const c = rate>=95?'#065f46':rate>=80?'#92400e':'#be123c';
          return `<span style="margin-right:12px"><b style="color:${c}">${s.name}</b> ${actual}H`;
        }).join('')}
      </div>
    </div>
  `;
  const card2 = document.getElementById('previewCard');
  const titleEl2 = card2?.querySelector('.card-title');
  if (titleEl2) titleEl2.insertAdjacentElement('afterend', summary);
  else card2?.prepend(summary);
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
