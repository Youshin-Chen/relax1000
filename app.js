/* 刷题中心 · 统一本地刷题程序 */
(function () {
  "use strict";

  const THEME_KEY = "relax1000_share_theme_v1";
  const LAST_BANK_KEY = "relax1000_share_last_bank_v1";
  const BANK_META_KEY = "relax1000_share_bank_meta_v1";
  const NOTE_MAX_LEN = 10000;
  const RESPONSE_MAX_LEN = 20000;
  const EXPLANATION_COLLAPSE_LENGTH = 300;
  const EMPTY_META = { total: 0, subjects: [], chapters: {} };

  // 题库分两种：本引擎驱动的（有 data）和独立页面的（有 href，点卡片直接跳过去）。
  const banks = (Array.isArray(window.QUIZ_BANKS) ? window.QUIZ_BANKS : []).filter(
    (bank) => bank && bank.id && bank.name && (bank.data || bank.href)
  );

  function isExternalBank(bank) {
    return !!(bank && bank.href && !bank.data);
  }

  // 题库相关状态在切换题库时整体替换，所以都是 let。
  let activeBank = null;
  let STORAGE_KEY = "";
  let data = null;
  let meta = EMPTY_META;
  let allQuestions = [];
  let allQuestionIds = new Set();
  let questionsById = new Map();
  // 科目 / 章节索引：首页与正确率汇总会反复取这些切片，
  // 1576 题量级下每次 filter 全表会明显拖慢渲染。
  let questionsBySubject = new Map();
  let questionsByChapter = new Map();
  const bankDataCache = new Map();
  const bankLoaders = new Map();
  // Every user navigation decision invalidates older asynchronous bank loads.
  // Without this token, a slow script can finish later and steal the page back.
  let bankSelectionVersion = 0;
  let methodFamilyFilter = "all";
  let pendingStorageWarning = "";
  let lastStorageWarning = "";
  let storageWriteFailed = false;
  const unsavedNoteIds = new Set();
  const tableResizeObservers = new WeakMap();

  /** @type {{done: Record<string, {choice:string, response?:string, review?:string, correct:boolean|null, ts:number}>, wrong: string[], last: {mode:string, subject?:string, chapterKey?:string, index:number, questionId?:string}|null, notes: Record<string, {text:string, updatedAt:number}>}} */
  let state = { done: {}, wrong: [], last: null, notes: {} };
  /** @type {{id: string, text: string}|null} */
  let pendingNote = null;
  let noteSaveTimer = null;
  let noteEditorOpen = false;
  let notePreviewMode = false;

  const el = {
    viewBanks: $("#view-banks"),
    viewHome: $("#view-home"),
    viewChapters: $("#view-chapters"),
    viewMethods: $("#view-methods"),
    viewQuiz: $("#view-quiz"),
    banksTitle: $("#banks-title"),
    banksNote: $("#banks-note"),
    bankGrid: $("#bank-grid"),
    brandTitle: $("#brand-title"),
    brandSub: $("#brand-sub"),
    btnBanks: $("#btn-banks"),
    btnMethods: $("#btn-methods"),
    methodsTitle: $("#methods-title"),
    methodFilter: $("#method-filter"),
    methodList: $("#method-list"),
    btnBackMethods: $("#btn-back-methods"),
    methodHint: $("#method-hint"),
    btnAi: $("#btn-ai"),
    homeTitle: $("#home-title"),
    homeGreeting: $("#home-greeting"),
    homeNudge: $("#home-nudge"),
    homeQuoteAuthor: $("#home-quote-author"),
    quizTitle: $("#quiz-title"),
    subjectGrid: $("#subject-grid"),
    homeStats: $("#home-stats"),
    accuracySummary: $("#accuracy-summary"),
    chapterTitle: $("#chapter-title"),
    chapterList: $("#chapter-list"),
    quizMeta: $("#quiz-meta"),
    quizProgress: $("#quiz-progress-fill"),
    quizProgressText: $("#quiz-progress-text"),
    questionGuideText: $("#question-guide-text"),
    shortcutHint: $(".shortcut-hint"),
    stem: $("#stem"),
    options: $("#options"),
    feedback: $("#feedback"),
    postAnswer: $("#post-answer"),
    postAnswerHint: $("#post-answer-hint"),
    explanation: $("#explanation"),
    explanationMeta: $("#explanation-meta"),
    explanationPreview: $("#explanation-preview"),
    explanationBody: $("#explanation-body"),
    notePanel: $("#note-panel"),
    noteBody: $("#note-body"),
    noteSnippet: $("#note-snippet"),
    noteEditPanel: $("#note-edit-panel"),
    noteInput: $("#note-input"),
    notePreview: $("#note-preview"),
    noteStatus: $("#note-status"),
    btnNoteToggle: $("#btn-note-toggle"),
    btnNoteEdit: $("#btn-note-edit"),
    btnNotePreviewTab: $("#btn-note-preview-tab"),
    btnNoteClear: $("#btn-note-clear"),
    btnPrev: $("#btn-prev"),
    btnNext: $("#btn-next"),
    btnNextAnswer: $("#btn-next-answer"),
    btnExplanationToggle: $("#btn-explanation-toggle"),
    btnRetry: $("#btn-retry"),
    btnHome: $("#btn-home"),
    btnBackChapters: $("#btn-back-chapters"),
    btnBackToChapters: $("#btn-back-to-chapters"),
    btnContinue: $("#btn-continue"),
    btnWrong: $("#btn-wrong"),
    btnNotes: $("#btn-notes"),
    btnReset: $("#btn-reset"),
    btnTheme: $("#btn-theme"),
    jumpInput: $("#jump-input"),
    btnJump: $("#btn-jump"),
    toast: $("#toast"),
    storageWarning: $("#storage-warning"),
  };

  /** @type {{list: typeof allQuestions, index: number, mode: string, subject?: string, chapterKey?: string, attempts: Record<string, {choice:string, correct:boolean|null, ts:number}>, drafts: Record<string, string>}} */
  let session = { list: [], index: 0, mode: "home", attempts: {}, drafts: {} };

  function $(sel) {
    return document.querySelector(sel);
  }

  function emptyState() {
    return { done: {}, wrong: [], last: null, notes: {} };
  }

  function isSubjectiveQuestion(q) {
    return !!q && q.kind === "subjective";
  }

  /* ==================== 题库层 ==================== */

  function bankById(id) {
    return banks.find((bank) => bank.id === id) || null;
  }

  /** 题库数据文件是普通 script，file:// 下也能加载；同一题库只加载一次 */
  function loadBankData(bank) {
    if (bankDataCache.has(bank.id)) return Promise.resolve(bankDataCache.get(bank.id));
    if (bankLoaders.has(bank.id)) return bankLoaders.get(bank.id);

    const loader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = bank.data;
      script.async = false;
      script.addEventListener("load", () => {
        const loaded = window.QUESTIONS_DATA;
        // 各题库数据文件都写同一个全局变量，取走后立刻清掉，避免互相串味。
        window.QUESTIONS_DATA = undefined;
        script.remove();
        if (!loaded || !Array.isArray(loaded.questions) || !loaded.questions.length) {
          reject(new Error(`题库「${bank.name}」的数据文件没有输出题目`));
          return;
        }
        if (!loaded.meta) loaded.meta = { total: loaded.questions.length, subjects: [], chapters: {} };
        if (!Number.isFinite(loaded.meta.total)) loaded.meta.total = loaded.questions.length;
        bankDataCache.set(bank.id, loaded);
        rememberBankMeta(bank.id, loaded.meta.total);
        resolve(loaded);
      });
      script.addEventListener("error", () => {
        script.remove();
        reject(new Error(`读不到题库文件：${bank.data}`));
      });
      document.head.appendChild(script);
    });
    loader.catch(() => {}).then(() => bankLoaders.delete(bank.id));
    bankLoaders.set(bank.id, loader);
    return loader;
  }

  /** 记住各题库的真实题量，题库选择页不用先加载数据也能显示进度 */
  function readBankMetaCache() {
    try {
      const raw = localStorage.getItem(BANK_META_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function rememberBankMeta(bankId, total) {
    const cache = readBankMetaCache();
    if (cache[bankId] === total) return;
    cache[bankId] = total;
    try {
      localStorage.setItem(BANK_META_KEY, JSON.stringify(cache));
    } catch (_) {}
  }

  function readBankState(bank) {
    try {
      const raw = localStorage.getItem(bank.storageKey || `quizhub_${bank.id}_v1`);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  /** 题库卡片上的概览；不加载题库数据，直接读本地进度 */
  function bankOverview(bank) {
    // 独立页面题库的进度由它自己那一页保存，这里不去猜它的存储格式。
    if (isExternalBank(bank)) {
      return { total: bank.total || 0, done: 0, wrong: 0, notes: 0, percent: 0, accuracy: null };
    }
    const cached = readBankMetaCache();
    const loaded = bankDataCache.get(bank.id);
    const total = loaded ? loaded.meta.total : cached[bank.id] || bank.total || 0;
    const raw = readBankState(bank);
    const done = raw && raw.done && typeof raw.done === "object" ? Object.keys(raw.done).length : 0;
    const wrong = raw && Array.isArray(raw.wrong) ? raw.wrong.length : 0;
    const notes = raw && raw.notes && typeof raw.notes === "object" ? Object.keys(raw.notes).length : 0;
    let correct = 0;
    let scored = 0;
    if (raw && raw.done && typeof raw.done === "object") {
      for (const result of Object.values(raw.done)) {
        if (!result || typeof result !== "object" || result.correct === null) continue;
        if (result.correct === true) correct += 1;
        if (result.correct === true || result.correct === false) scored += 1;
      }
    }
    return {
      total,
      done: Math.min(done, total || done),
      wrong,
      notes,
      percent: total ? Math.round((Math.min(done, total) / total) * 100) : 0,
      accuracy: scored ? Math.round((correct / scored) * 100) : null,
    };
  }

  function runLegacyImport(bank) {
    if (isExternalBank(bank)) return;
    if (!bank.legacy || typeof bank.legacy.read !== "function") return;
    const flag = bank.legacy.flag || `quizhub_migrated_${bank.id}`;
    try {
      if (localStorage.getItem(flag)) return;
    } catch (_) {
      return;
    }
    let imported = null;
    try {
      imported = bank.legacy.read();
    } catch (_) {
      imported = null;
    }
    try {
      localStorage.setItem(flag, String(Date.now()));
    } catch (_) {}
    if (!imported) return;
    const key = bank.storageKey || `quizhub_${bank.id}_v1`;
    try {
      if (localStorage.getItem(key)) return; // 新进度已存在，不覆盖
      localStorage.setItem(key, JSON.stringify(imported));
    } catch (_) {}
  }

  function renderBankChooser(message) {
    if (!el.bankGrid) return;
    document.body.dataset.bank = "";
    el.bankGrid.innerHTML = "";
    if (!banks.length) {
      el.bankGrid.innerHTML =
        '<p class="bank-loading">banks.js 里还没有登记任何题库。</p>';
      return;
    }
    if (el.banksNote) {
      el.banksNote.textContent = message || `共 ${banks.length} 个题库 · 进度分开保存`;
    }
    banks.forEach((bank, index) => {
      const external = isExternalBank(bank);
      const overview = bankOverview(bank);
      // 独立页面题库用 <a>，这样中键、右键新标签页打开都照常可用。
      const card = document.createElement(external ? "a" : "button");
      if (external) {
        card.href = bank.href;
      } else {
        card.type = "button";
      }
      card.className = "bank-card";
      if (external) card.classList.add("is-external");
      if (activeBank && activeBank.id === bank.id) card.classList.add("is-active");
      card.dataset.bank = bank.id;
      card.dataset.accent = String((index % 6) + 1);
      const tags = Array.isArray(bank.tags) ? bank.tags : [];
      card.innerHTML = `
        <div class="bank-card-head">
          <span class="bank-badge">${escapeHtml(bank.badge || bank.name.slice(0, 2))}</span>
          ${
            external
              ? '<span class="subject-arrow" aria-hidden="true">↗</span>'
              : activeBank && activeBank.id === bank.id
                ? '<span class="bank-card-flag">当前题库</span>'
                : '<span class="subject-arrow" aria-hidden="true">→</span>'
          }
        </div>
        <h3>${escapeHtml(bank.name)}</h3>
        ${bank.subtitle ? `<p class="bank-sub">${escapeHtml(bank.subtitle)}</p>` : ""}
        ${
          tags.length
            ? `<div class="bank-tags">${tags
                .map((tag) => `<span class="bank-tag">${escapeHtml(tag)}</span>`)
                .join("")}</div>`
            : ""
        }
        ${
          external
            ? `<div class="bank-stats">
          <span>题量 <strong>${bank.total || "—"}</strong></span>
          <span class="bank-open-hint">进度在该页面单独保存</span>
        </div>`
            : `<div class="bank-stats">
          <span>题量 <strong>${overview.total || "—"}</strong></span>
          <span>已做 <strong>${overview.done}</strong></span>
          <span>错题 <strong>${overview.wrong}</strong></span>
          <span>正确率 <strong>${overview.accuracy === null ? "—" : `${overview.accuracy}%`}</strong></span>
        </div>
        <div class="progress-bar"><i style="width:${overview.percent}%"></i></div>`
        }
      `;
      if (!external) card.addEventListener("click", () => selectBank(bank.id));
      el.bankGrid.appendChild(card);
    });
  }

  function showBankChooser(message) {
    bankSelectionVersion += 1;
    flushNoteSave();
    noteEditorOpen = false;
    notePreviewMode = false;
    if (window.QuizAI) window.QuizAI.close();
    renderBankChooser(message);
    updateTopbar();
    showView("banks");
  }

  function updateTopbar() {
    if (el.brandTitle) el.brandTitle.textContent = activeBank ? activeBank.name : "刷题中心";
    if (el.brandSub) {
      el.brandSub.textContent = activeBank
        ? `${meta.total} 题 · 进度自动保存`
        : "选择一个题库开始";
    }
    if (el.btnHome) {
      const hasActiveBank = !!activeBank;
      const homeHint = hasActiveBank ? `返回「${activeBank.name}」题库首页` : "先选择一个题库";
      el.btnHome.disabled = !hasActiveBank;
      el.btnHome.title = homeHint;
      el.btnHome.setAttribute("aria-label", hasActiveBank ? `题库首页，${activeBank.name}` : `题库首页，${homeHint}`);
    }
    if (el.btnReset) el.btnReset.classList.toggle("hidden", !activeBank);
    if (el.btnMethods) el.btnMethods.classList.toggle("hidden", !hasMethodLibrary());
  }

  function syncLocationNav(viewName) {
    const currentByButton = new Map([
      [el.btnBanks, viewName === "banks"],
      [el.btnHome, viewName === "home"],
    ]);
    for (const [button, isCurrent] of currentByButton) {
      if (!button) continue;
      button.classList.toggle("is-current", isCurrent);
      if (isCurrent) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  function selectBank(bankId, options) {
    const selectionVersion = ++bankSelectionVersion;
    const bank = bankById(bankId);
    if (!bank) {
      showBankChooser("题库不存在，请检查 banks.js");
      return Promise.resolve(false);
    }
    // 独立页面题库不由本引擎驱动，卡片本身就是链接，不该走到这里。
    if (isExternalBank(bank)) return Promise.resolve(false);
    if (activeBank && activeBank.id === bank.id && data) {
      renderHome();
      return Promise.resolve(true);
    }
    if (el.banksNote) el.banksNote.textContent = `正在载入「${bank.name}」…`;
    return loadBankData(bank)
      .then((loaded) => {
        if (selectionVersion !== bankSelectionVersion) return false;
        runLegacyImport(bank);
        activateBank(bank, loaded);
        return true;
      })
      .catch((error) => {
        if (selectionVersion !== bankSelectionVersion) return false;
        const detail = error && error.message ? error.message : "题库加载失败";
        if (options && options.silent) {
          showBankChooser(detail);
        } else {
          showBankChooser(detail);
          toast(detail);
        }
        return false;
      });
  }

  function activateBank(bank, loaded) {
    flushNoteSave();
    noteEditorOpen = false;
    notePreviewMode = false;
    pendingNote = null;
    unsavedNoteIds.clear();
    storageWriteFailed = false;
    lastStorageWarning = "";
    if (el.storageWarning) el.storageWarning.hidden = true;

    activeBank = bank;
    data = loaded;
    meta = loaded.meta;
    allQuestions = loaded.questions;
    allQuestionIds = new Set(allQuestions.map((q) => String(q.id)));
    questionsById = new Map(allQuestions.map((q) => [String(q.id), q]));
    questionsBySubject = new Map();
    questionsByChapter = new Map();
    for (const q of allQuestions) {
      const subjectList = questionsBySubject.get(q.subject);
      if (subjectList) subjectList.push(q);
      else questionsBySubject.set(q.subject, [q]);
      const chapterKey = chapterIndexKey(q.subject, q.chapterKey);
      const chapterList = questionsByChapter.get(chapterKey);
      if (chapterList) chapterList.push(q);
      else questionsByChapter.set(chapterKey, [q]);
    }
    STORAGE_KEY = bank.storageKey || `quizhub_${bank.id}_v1`;
    methodFamilyFilter = "all";
    session = { list: [], index: 0, mode: "home", attempts: {}, drafts: {} };
    state = loadState();
    document.body.dataset.bank = bank.id;
    try {
      localStorage.setItem(LAST_BANK_KEY, bank.id);
    } catch (_) {}
    if (window.QuizAI) window.QuizAI.setBank(bank, meta);
    updateTopbar();
    saveState();
    renderHome();
  }

  /** 题库里图片是相对自己目录写的，这里补上题库根路径 */
  function resolveAssetUrl(source) {
    const raw = String(source || "").trim();
    if (!raw) return raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("/")) return raw;
    if (raw.startsWith("#") || raw.startsWith("?")) return raw;
    const base = activeBank && activeBank.assetBase !== undefined
      ? activeBank.assetBase
      : activeBank
        ? activeBank.data.replace(/[^/]*$/, "")
        : "";
    if (!base) return raw;
    return `${base.replace(/\/*$/, "/")}${raw.replace(/^\.\//, "")}`;
  }

  function hasMethodLibrary() {
    return !!(meta && Array.isArray(meta.methodLibrary) && meta.methodLibrary.length);
  }

  function methodById(id) {
    if (!hasMethodLibrary()) return null;
    return meta.methodLibrary.find((method) => method.id === id) || null;
  }

  function methodsForQuestion(q) {
    if (!q || !Array.isArray(q.methods) || !hasMethodLibrary()) return [];
    return q.methods.map((id) => methodById(id)).filter(Boolean);
  }

  function renderMethodHint(q) {
    if (!el.methodHint) return;
    const methods = methodsForQuestion(q);
    if (!methods.length) {
      el.methodHint.classList.add("hidden");
      el.methodHint.innerHTML = "";
      return;
    }
    const primary = methods[0];
    const supporting = methods.slice(1);
    const rows = [
      `<p><b>识别信号</b> ${escapeHtml(primary.signal || "")}</p>`,
      `<p><b>第一动作</b> ${escapeHtml(primary.move || "")}</p>`,
    ];
    if (primary.pitfall) rows.push(`<p><b>易错</b> ${escapeHtml(primary.pitfall)}</p>`);
    if (supporting.length) {
      rows.push(
        `<p><b>辅助通法</b> ${escapeHtml(
          supporting.map((method) => `${method.id} ${method.name}`).join("、")
        )}</p>`
      );
    }
    el.methodHint.classList.remove("hidden");
    el.methodHint.innerHTML = `
      <details>
        <summary>本题通法：${escapeHtml(primary.id)} ${escapeHtml(primary.name)}</summary>
        <div class="method-hint-body">${rows.join("")}</div>
      </details>
    `;
    typesetMath(el.methodHint);
  }

  function openMethodCenter() {
    if (!hasMethodLibrary()) {
      toast("本题库没有通法库");
      return;
    }
    renderMethodCenter();
    showView("methods");
  }

  function renderMethodCenter() {
    const families = ["all", ...new Set(meta.methodLibrary.map((method) => method.family))];
    if (el.methodFilter) {
      el.methodFilter.innerHTML = "";
      for (const family of families) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `method-chip${family === methodFamilyFilter ? " is-active" : ""}`;
        chip.textContent = family === "all" ? "全部" : family;
        chip.setAttribute("aria-pressed", String(family === methodFamilyFilter));
        chip.addEventListener("click", () => {
          methodFamilyFilter = family;
          renderMethodCenter();
        });
        el.methodFilter.appendChild(chip);
      }
    }
    if (!el.methodList) return;
    const list = meta.methodLibrary.filter(
      (method) => methodFamilyFilter === "all" || method.family === methodFamilyFilter
    );
    el.methodList.innerHTML = list
      .map(
        (method) => `
        <article class="method-card">
          <div class="method-card-head">
            <span class="method-id">${escapeHtml(method.id)}</span>
            <h3>${escapeHtml(method.name)}</h3>
            <span class="method-family">${escapeHtml(method.family || "")}</span>
          </div>
          <dl>
            ${method.question ? `<dt>要解决</dt><dd>${escapeHtml(method.question)}</dd>` : ""}
            ${method.signal ? `<dt>识别信号</dt><dd>${escapeHtml(method.signal)}</dd>` : ""}
            ${method.move ? `<dt>第一动作</dt><dd>${escapeHtml(method.move)}</dd>` : ""}
            ${method.pitfall ? `<dt>易错</dt><dd>${escapeHtml(method.pitfall)}</dd>` : ""}
          </dl>
          ${
            Array.isArray(method.steps) && method.steps.length
              ? `<ol>${method.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`
              : ""
          }
        </article>
      `
      )
      .join("");
    typesetMath(el.methodList);
  }

  /* ==================== 题库层结束 ==================== */

  function correctnessForChoice(q, choice) {
    if (isSubjectiveQuestion(q)) return null;
    const answerParts = getAnswerParts(q);
    if (!answerParts.length) return null;
    return (
      choice.length === answerParts.length &&
      answerParts.every((answer, index) => choice.charAt(index) === answer)
    );
  }

  function normalizeStoredState(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    const done = {};
    if (parsed.done && typeof parsed.done === "object" && !Array.isArray(parsed.done)) {
      for (const [id, result] of Object.entries(parsed.done)) {
        const q = questionsById.get(id);
        if (!q || !result || typeof result !== "object") continue;
        if (isSubjectiveQuestion(q)) {
          const choice = String(result.choice || "").toUpperCase();
          if (choice !== "REVIEWED") continue;
          const review = ["pending", "mastered", "revisit"].includes(result.review)
            ? result.review
            : "pending";
          done[id] = {
            choice: "REVIEWED",
            response: String(result.response || "").slice(0, RESPONSE_MAX_LEN),
            review,
            correct: null,
            ts: Number.isFinite(result.ts) ? result.ts : 0,
          };
          continue;
        }
        const choice = (Array.isArray(result.choice)
          ? result.choice.join("")
          : String(result.choice || "")
        ).toUpperCase();
        const expectedLength = Math.max(getAnswerParts(q).length, 1);
        if (!/^[A-D]+$/.test(choice) || choice.length !== expectedLength) continue;
        done[id] = {
          choice,
          // `correct` is derived from the current dataset so answer fixes do
          // not leave historical statistics permanently stale.
          correct: correctnessForChoice(q, choice),
          ts: Number.isFinite(result.ts) ? result.ts : 0,
        };
      }
    }

    const wrongSet = new Set(
      Array.isArray(parsed.wrong)
        ? parsed.wrong.map(String).filter((id) => allQuestionIds.has(id))
        : []
    );
    for (const [id, result] of Object.entries(done)) {
      const q = questionsById.get(id);
      if (isSubjectiveQuestion(q)) {
        if (result.review === "revisit") wrongSet.add(id);
        else wrongSet.delete(id);
      } else if (result.correct === false) {
        wrongSet.add(id);
      } else {
        wrongSet.delete(id);
      }
    }

    const notes = {};
    if (parsed.notes && typeof parsed.notes === "object" && !Array.isArray(parsed.notes)) {
      for (const [id, note] of Object.entries(parsed.notes)) {
        if (!allQuestionIds.has(id) || !note || typeof note !== "object") continue;
        const text = String(note.text || "").slice(0, NOTE_MAX_LEN);
        if (!text.trim()) continue;
        notes[id] = {
          text,
          updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : 0,
        };
      }
    }

    const validModes = new Set(["wrong", "subject", "chapter", "notes"]);
    const last =
      parsed.last && typeof parsed.last === "object" && validModes.has(parsed.last.mode)
        ? {
            mode: parsed.last.mode,
            subject: typeof parsed.last.subject === "string" ? parsed.last.subject : undefined,
            chapterKey:
              typeof parsed.last.chapterKey === "string" ? parsed.last.chapterKey : undefined,
            index:
              Number.isInteger(parsed.last.index) && parsed.last.index >= 0 ? parsed.last.index : 0,
            questionId:
              parsed.last.questionId && allQuestionIds.has(String(parsed.last.questionId))
                ? String(parsed.last.questionId)
                : undefined,
          }
        : null;
    return { done, wrong: [...wrongSet], last, notes };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? normalizeStoredState(JSON.parse(raw)) : emptyState();
    } catch (_) {
      pendingStorageWarning = "本地进度无法读取，已使用空进度";
      return emptyState();
    }
  }

  // Every mutation starts from the latest persisted snapshot. This prevents a
  // stale second tab from overwriting answers or notes merely by navigating.
  function saveState(mutator) {
    if (!STORAGE_KEY) return false;
    let next = state;
    if (!storageWriteFailed) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) next = normalizeStoredState(JSON.parse(raw));
      } catch (_) {
        showStorageWarning("本地进度无法读取，已继续使用当前页面中的进度");
      }
    }
    if (typeof mutator === "function") mutator(next);
    state = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageWriteFailed = false;
      unsavedNoteIds.clear();
      return true;
    } catch (_) {
      storageWriteFailed = true;
      showStorageWarning("浏览器无法保存进度，本次操作仅在当前页面有效");
      return false;
    }
  }

  function showStorageWarning(message) {
    if (lastStorageWarning === message) return;
    lastStorageWarning = message;
    pendingStorageWarning = "";
    if (el.storageWarning) {
      el.storageWarning.textContent = message;
      el.storageWarning.hidden = false;
      el.storageWarning.setAttribute("aria-live", "assertive");
    } else {
      toast(message);
    }
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.remove("show"), 1800);
  }

  function applyTheme(theme, persist) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    const isDark = nextTheme === "dark";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;

    const themeColor = $("#theme-color");
    if (themeColor) themeColor.content = isDark ? "#15181b" : "#f3f5f7";
    if (el.btnTheme) {
      el.btnTheme.textContent = isDark ? "☀ 浅色" : "☾ 暗色";
      el.btnTheme.setAttribute("aria-pressed", String(isDark));
      el.btnTheme.setAttribute("aria-label", isDark ? "切换到浅色主题" : "切换到暗色主题");
      el.btnTheme.title = isDark ? "切换到浅色主题" : "切换到暗色主题";
    }

    if (!persist) return;
    try {
      localStorage.setItem(THEME_KEY, nextTheme);
    } catch (_) {
      showStorageWarning("浏览器无法保存主题，本次切换仅在当前页面有效");
    }
  }

  function toggleTheme() {
    const currentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    applyTheme(currentTheme === "dark" ? "light" : "dark", true);
  }

  function showView(name) {
    document.body.dataset.view = name;
    syncLocationNav(name);
    const views = {
      banks: el.viewBanks,
      home: el.viewHome,
      chapters: el.viewChapters,
      methods: el.viewMethods,
      quiz: el.viewQuiz,
    };
    for (const [viewName, node] of Object.entries(views)) {
      if (!node) continue;
      const active = viewName === name;
      node.classList.toggle("hidden", !active);
      node.setAttribute("aria-hidden", String(!active));
    }
    const focusTarget =
      name === "banks"
        ? el.banksTitle || el.viewBanks
        : name === "home"
          ? el.homeTitle || el.viewHome
          : name === "chapters"
            ? el.chapterTitle || el.viewChapters
            : name === "methods"
              ? el.methodsTitle || el.viewMethods
              : el.quizTitle || el.stem || el.viewQuiz;
    if (focusTarget) {
      focusTarget.tabIndex = -1;
      focusTarget.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
  }

  const EMPTY_LIST = [];

  /**
   * 章节索引的唯一键。建索引和查索引都必须走这一个函数。
   * 修复的 bug：建索引时拼的是 subject + 空格 + chapterKey，查询时拼的是
   * subject + NUL + chapterKey，两边键永远对不上 —— chapterQuestions() 恒返回
   * 空数组，openChapters() 里的 if (!list.length) continue 于是跳过每一个章节，
   * 页面上只剩一条「本科目全部题目」。
   * 分隔符固定用 U+001F（单元分隔符）：subject 与 chapterKey 都不含该字符，
   * 所以不会出现 "a"+"b c" 和 "a b"+"c" 撞成同一个键的情况。
   */
  function chapterIndexKey(sid, ckey) {
    return `${sid}${ckey}`;
  }

  function subjectQuestions(sid) {
    return questionsBySubject.get(sid) || EMPTY_LIST;
  }

  function chapterQuestions(sid, ckey) {
    return questionsByChapter.get(chapterIndexKey(sid, ckey)) || EMPTY_LIST;
  }

  /** 错题列表；传入 subjectId 时按每日题或模拟卷过滤 */
  function wrongQuestions(subjectId) {
    const wrongSet = new Set(state.wrong.map(String));
    return allQuestions.filter((q) => {
      if (!wrongSet.has(String(q.id))) return false;
      if (subjectId && q.subject !== subjectId) return false;
      return true;
    });
  }

  function progressOf(list) {
    let done = 0;
    let correct = 0;
    let scored = 0;
    for (const q of list) {
      const r = state.done[q.id];
      if (r) {
        done += 1;
        if (r.correct !== null) scored += 1;
        if (r.correct === true) correct += 1;
      }
    }
    return { total: list.length, done, correct, scored };
  }

  function accuracyPercent(progress) {
    return progress.scored ? Math.round((progress.correct / progress.scored) * 100) : null;
  }

  function accuracyLabel(progress) {
    const percent = accuracyPercent(progress);
    return percent === null ? "—" : `${percent}%`;
  }

  function renderAccuracySummary() {
    const overall = progressOf(allQuestions);
    const overallPercent = accuracyPercent(overall);
    const incorrect = overall.scored - overall.correct;
    const overallDetail = overall.scored
      ? `答对 ${overall.correct} · 答错 ${incorrect} · 共判定 ${overall.scored}`
      : "完成答题后，这里会显示正确率";
    const groupedQuestions = new Map();
    for (const subject of meta.subjects) {
      const groupName = subject.group || subject.name;
      const current = groupedQuestions.get(groupName) || [];
      current.push(...subjectQuestions(subject.id));
      groupedQuestions.set(groupName, current);
    }
    const subjectItems = [...groupedQuestions.entries()]
      .map(([groupName, questions]) => {
        const progress = progressOf(questions);
        const percent = accuracyPercent(progress);
        const percentValue = percent === null ? 0 : percent;
        const detail = progress.scored
          ? `正确 ${progress.correct} / ${progress.scored}`
          : "暂无作答";
        const ariaLabel =
          percent === null
            ? `${groupName}正确率：暂无作答`
            : `${groupName}正确率：${percent}%`;
        return `
          <div class="accuracy-item">
            <div class="accuracy-item-head">
              <span>${escapeHtml(groupName)}</span>
              <strong>${accuracyLabel(progress)}</strong>
            </div>
            <div class="accuracy-detail">${detail}</div>
            <div class="accuracy-bar" role="progressbar" aria-label="${escapeHtml(
              ariaLabel
            )}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentValue}">
              <i style="width:${percentValue}%"></i>
            </div>
          </div>
        `;
      })
      .join("");

    el.accuracySummary.innerHTML = `
      <div class="accuracy-overall">
        <span>总正确率</span>
        <strong id="accuracy-overall-value">${overallPercent === null ? "—" : `${overallPercent}%`}</strong>
        <small>${overallDetail}</small>
      </div>
      <div class="accuracy-subjects">${subjectItems}</div>
    `;
  }

  /** 计算机领域中英双语名言；按一年中的第几天轮换，当日固定 */
  const DAILY_QUOTES = [
    {
      zh: "空谈无益，给我看代码。",
      en: "Talk is cheap. Show me the code.",
      author: "Linus Torvalds",
    },
    {
      zh: "过早优化是万恶之源。",
      en: "Premature optimization is the root of all evil.",
      author: "Donald Knuth",
    },
    {
      zh: "程序首先是写给人读的，只是顺便让机器执行。",
      en: "Programs must be written for people to read, and only incidentally for machines to execute.",
      author: "Harold Abelson & Gerald Jay Sussman",
    },
    {
      zh: "调试的难度是写代码的两倍。因此，如果你写代码时已经用尽全力，你将没有余力调试。",
      en: "Debugging is twice as hard as writing the code in the first place. Therefore, if you write the code as cleverly as possible, you are, by definition, not smart enough to debug it.",
      author: "Brian Kernighan",
    },
    {
      zh: "计算机科学里只有两件难事：缓存失效和命名。",
      en: "There are only two hard things in Computer Science: cache invalidation and naming things.",
      author: "Phil Karlton",
    },
    {
      zh: "先让它跑起来，再让它正确，最后再让它快。",
      en: "Make it work, make it right, make it fast.",
      author: "Kent Beck",
    },
    {
      zh: "任何一个傻瓜都能写出计算机能理解的代码；优秀的程序员写出人能理解的代码。",
      en: "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.",
      author: "Martin Fowler",
    },
    {
      zh: "预测未来最好的方式，就是去发明它。",
      en: "The best way to predict the future is to invent it.",
      author: "Alan Kay",
    },
    {
      zh: "简单的事情应当简单，复杂的事情应当可能。",
      en: "Simple things should be simple, complex things should be possible.",
      author: "Alan Kay",
    },
    {
      zh: "控制复杂性，是计算机编程的本质。",
      en: "Controlling complexity is the essence of computer programming.",
      author: "Brian Kernighan",
    },
    {
      zh: "学习一门新语言的唯一办法，是用它写程序。",
      en: "The only way to learn a new programming language is by writing programs in it.",
      author: "Dennis Ritchie",
    },
    {
      zh: "如果调试是去除 bug 的过程，那么编程一定是放入 bug 的过程。",
      en: "If debugging is the process of removing software bugs, then programming must be the process of putting them in.",
      author: "Edsger W. Dijkstra",
    },
    {
      zh: "用代码行数衡量编程进度，就像用重量衡量飞机制造进度。",
      en: "Measuring programming progress by lines of code is like measuring aircraft building progress by weight.",
      author: "Bill Gates",
    },
    {
      zh: "程序最重要的性质，是它是否实现了用户的意图。",
      en: "The most important property of a program is whether it accomplishes the intention of its user.",
      author: "C. A. R. Hoare",
    },
    {
      zh: "不要给烂代码写注释——重写它。",
      en: "Don't comment bad code — rewrite it.",
      author: "Brian Kernighan & P. J. Plauger",
    },
    {
      zh: "我最高产的一天之一，是扔掉一千行代码的那天。",
      en: "One of my most productive days was throwing away 1000 lines of code.",
      author: "Ken Thompson",
    },
    {
      zh: "有疑问时，用暴力解法。",
      en: "When in doubt, use brute force.",
      author: "Ken Thompson",
    },
    {
      zh: "删除的代码，才是已调试的代码。",
      en: "Deleted code is debugged code.",
      author: "Jeff Sickel",
    },
    {
      zh: "文档是你写给未来自己的情书。",
      en: "Documentation is a love letter that you write to your future self.",
      author: "Damian Conway",
    },
    {
      zh: "一门不影响你思考编程方式的语言，不值得去学。",
      en: "A language that doesn't affect the way you think about programming is not worth knowing.",
      author: "Alan Perlis",
    },
    {
      zh: "愚者无视复杂性，务实者忍受它，有人能规避它，天才消除它。",
      en: "Fools ignore complexity. Pragmatists suffer it. Some can avoid it. Geniuses remove it.",
      author: "Alan Perlis",
    },
    {
      zh: "最好的性能提升，是从「不能工作」到「能工作」。",
      en: "The best performance improvement is the transition from the nonworking state to the working state.",
      author: "John Ousterhout",
    },
    {
      zh: "软件的功能是让复杂看起来简单。",
      en: "The function of good software is to make the complex appear to be simple.",
      author: "Grady Booch",
    },
    {
      zh: "如果你优化一切，你将永远不快乐。",
      en: "If you optimize everything, you will always be unhappy.",
      author: "Donald Knuth",
    },
    {
      zh: "C 让你很容易射中自己的脚；C++ 让这更难，但一旦射中，整条腿都没了。",
      en: "C makes it easy to shoot yourself in the foot; C++ makes it harder, but when you do it blows your whole leg off.",
      author: "Bjarne Stroustrup",
    },
    {
      zh: "最有效的调试工具，仍是仔细思考，外加审慎放置的打印语句。",
      en: "The most effective debugging tool is still careful thought, coupled with judiciously placed print statements.",
      author: "Brian Kernighan",
    },
    {
      zh: "先解决问题，再写代码。",
      en: "First, solve the problem. Then, write the code.",
      author: "John Johnson",
    },
    {
      zh: "最便宜、最快、最可靠的组件，是那些根本不存在的组件。",
      en: "The cheapest, fastest, and most reliable components are those that aren't there.",
      author: "Gordon Bell",
    },
    {
      zh: "在软件可复用之前，它首先必须可用。",
      en: "Before software can be reusable it first has to be usable.",
      author: "Ralph Johnson",
    },
    {
      zh: "抽象是有选择的忽略。",
      en: "Abstraction is selective ignorance.",
      author: "Andrew Koenig",
    },
    {
      zh: "智能，是能够避免做事，却仍把事情做成。",
      en: "Intelligence is the ability to avoid doing work, yet getting the work done.",
      author: "Linus Torvalds",
    },
  ];

  function getDailyQuote(date = new Date()) {
    const start = new Date(date.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((date - start) / 86400000);
    return DAILY_QUOTES[((dayOfYear % DAILY_QUOTES.length) + DAILY_QUOTES.length) % DAILY_QUOTES.length];
  }

  function renderHome() {
    if (!activeBank) {
      showBankChooser();
      return;
    }
    if (window.QuizAI) window.QuizAI.close();
    updateTopbar();
    showView("home");
    session.mode = "home";

    const results = Object.values(state.done);
    const totalDone = results.length;
    const scoredCount = results.filter((x) => x.correct !== null).length;
    const totalCorrect = results.filter((x) => x.correct === true).length;
    const wrongCount = state.wrong.length;
    const notesCount = notedQuestions().length;
    const quote = getDailyQuote();
    if (el.homeGreeting) el.homeGreeting.textContent = quote.en;
    if (el.homeNudge) el.homeNudge.textContent = quote.zh;
    if (el.homeQuoteAuthor) el.homeQuoteAuthor.textContent = `— ${quote.author}`;
    el.homeStats.innerHTML = `
      <span>题库 <strong>${escapeHtml(meta.total)}</strong> 题</span>
      <span>已做 <strong>${totalDone}</strong></span>
      <span>正确 <strong>${totalCorrect}</strong>${
        scoredCount ? `（${Math.round((totalCorrect / scoredCount) * 100)}%）` : ""
      }</span>
      <span>错题 <strong>${wrongCount}</strong></span>
      <span>笔记 <strong>${notesCount}</strong></span>
    `;
    renderAccuracySummary();

    el.subjectGrid.innerHTML = "";
    for (const s of meta.subjects) {
      const list = subjectQuestions(s.id);
      const p = progressOf(list);
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "subject-card";
      card.dataset.subject = s.id;
      card.innerHTML = `
        <div class="subject-card-heading">
          <span class="subject-code" aria-hidden="true">${escapeHtml(s.code || s.id.toUpperCase())}</span>
          <span class="subject-arrow" aria-hidden="true">→</span>
        </div>
        <h3>${escapeHtml(s.name)}</h3>
        <div class="meta">已做 ${p.done}/${p.total}<span>正确率 ${accuracyLabel(p)}</span></div>
        <div class="progress-bar"><i style="width:${pct}%"></i></div>
      `;
      card.addEventListener("click", () => openChapters(s.id));
      el.subjectGrid.appendChild(card);
    }

    el.btnContinue.disabled =
      !state.last ||
      !state.last.mode ||
      (state.last.mode === "wrong" && state.wrong.length === 0) ||
      (state.last.mode === "notes" && notesCount === 0);
    el.btnWrong.disabled = state.wrong.length === 0;
    if (el.btnNotes) el.btnNotes.disabled = notesCount === 0;
    if (el.btnMethods) el.btnMethods.classList.toggle("hidden", !hasMethodLibrary());
  }

  function notedQuestions() {
    return allQuestions
      .filter((q) => {
        const note = state.notes[q.id];
        return note && String(note.text || "").trim();
      })
      .sort(
        (a, b) =>
          (state.notes[b.id].updatedAt || 0) - (state.notes[a.id].updatedAt || 0)
      );
  }

  /** 「整套顺序刷」入口的文案，按题库类型给不同说法 */
  function allEntryCopy(subjectId, isDaily) {
    if (meta.allLabel) return { name: meta.allLabel, badge: meta.allBadge || "全部" };
    if (isDaily) return { name: "全部题目顺序刷", badge: "全部" };
    if (meta.mode === "papers") return { name: "整卷顺序刷", badge: "整卷" };
    return { name: "本科目全部题目", badge: "全部" };
  }

  function openChapters(subjectId) {
    const subj = meta.subjects.find((s) => s.id === subjectId);
    const chapters = meta.chapters[subjectId] || [];
    const isDaily = subjectId === "daily";
    if (el.viewChapters) {
      el.viewChapters.dataset.subject = subjectId;
      delete el.viewChapters.dataset.mode;
    }
    el.chapterTitle.textContent = subj ? subj.name : subjectId;
    if (el.btnBackChapters) el.btnBackChapters.textContent = "返回首页";
    el.chapterList.innerHTML = "";

    // 该科目 / 该套卷 / 该章的全部题目
    {
      const list = subjectQuestions(subjectId);
      const p = progressOf(list);
      const copy = allEntryCopy(subjectId, isDaily);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chapter-item";
      item.dataset.subject = subjectId;
      item.innerHTML = `
        <div class="left">
          <div class="name">${escapeHtml(copy.name)}</div>
          <div class="sub">共 ${p.total} 题 · 已做 ${p.done} · 正确率 ${accuracyLabel(p)}</div>
        </div>
        <span class="badge">${escapeHtml(copy.badge)}</span>
      `;
      item.addEventListener("click", () =>
        startSession(list, { mode: "subject", subject: subjectId, index: firstUnanswered(list) })
      );
      el.chapterList.appendChild(item);
    }

    for (const ch of chapters) {
      const list = chapterQuestions(subjectId, ch.key);
      if (!list.length) continue;
      const p = progressOf(list);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chapter-item";
      item.innerHTML = `
        <div class="left">
          <div class="name">${escapeHtml(ch.name)}</div>
          <div class="sub">共 ${p.total} 题 · 已做 ${p.done} · 正确率 ${accuracyLabel(p)}</div>
        </div>
        <span class="badge">${p.total}</span>
      `;
      item.addEventListener("click", () =>
        startSession(list, {
          mode: "chapter",
          subject: subjectId,
          chapterKey: ch.key,
          index: firstUnanswered(list),
        })
      );
      el.chapterList.appendChild(item);
    }

    showView("chapters");
  }

  function firstUnanswered(list) {
    for (let i = 0; i < list.length; i++) {
      if (!state.done[list[i].id]) return i;
    }
    return 0;
  }

  function startSession(list, opts) {
    if (!list.length) {
      toast("没有题目");
      return;
    }
    flushNoteSave();
    noteEditorOpen = false;
    notePreviewMode = false;
    session = {
      list,
      index: Math.min(Math.max(opts.index || 0, 0), list.length - 1),
      mode: opts.mode || "chapter",
      subject: opts.subject,
      chapterKey: opts.chapterKey,
      attempts: {},
      drafts: {},
    };
    showView("quiz");
    renderQuestion("question");
  }

  function rememberSessionPosition() {
    const q = currentQ();
    const position = {
      mode: session.mode,
      subject: session.subject,
      chapterKey: session.chapterKey,
      index: session.index,
      questionId: q ? String(q.id) : undefined,
    };
    saveState((latest) => {
      latest.last = position;
    });
  }

  function resumeIndex(list, last) {
    if (!list.length) return 0;
    if (last && last.questionId) {
      const found = list.findIndex((q) => String(q.id) === String(last.questionId));
      if (found >= 0) return found;
    }
    const raw = last && Number.isInteger(last.index) ? last.index : 0;
    return Math.min(Math.max(raw, 0), list.length - 1);
  }

  function continueLast() {
    const last = state.last;
    if (!last) return;
    let list = [];
    if (last.mode === "wrong") {
      list = wrongQuestions(last.subject);
    } else if (last.mode === "notes") {
      list = notedQuestions();
    } else if (last.mode === "subject" && last.subject) {
      list = subjectQuestions(last.subject);
    } else if (last.mode === "chapter" && last.subject && last.chapterKey) {
      list = chapterQuestions(last.subject, last.chapterKey);
    } else {
      toast("无法恢复上次进度");
      return;
    }
    if (!list.length) {
      toast("题目列表为空");
      return;
    }
    startSession(list, {
      mode: last.mode,
      subject: last.subject,
      chapterKey: last.chapterKey,
      index: resumeIndex(list, last),
    });
  }

  function backToChaptersFromQuiz() {
    flushNoteSave();
    noteEditorOpen = false;
    notePreviewMode = false;
    if (session.mode === "wrong") {
      openWrongBook();
      return;
    }
    if (session.subject) {
      openChapters(session.subject);
      return;
    }
    renderHome();
  }

  function retryCurrentQuestion() {
    const q = currentQ();
    if (!q) return;
    const answered = session.mode === "wrong" ? session.attempts[q.id] : state.done[q.id];
    if (!answered) {
      toast("本题尚未作答");
      return;
    }
    flushNoteSave();
    noteEditorOpen = false;
    notePreviewMode = false;
    const questionId = String(q.id);
    delete session.attempts[questionId];
    delete session.drafts[questionId];
    saveState((latest) => {
      delete latest.done[questionId];
      // A wrong-book question stays in the book until a replacement answer is
      // submitted. Retrying a just-corrected item must therefore restore it.
      if (session.mode === "wrong" && !latest.wrong.includes(questionId)) {
        latest.wrong.push(questionId);
      }
    });
    renderQuestion("option");
    toast("已清除本题作答，请重新完成");
  }

  function openWrongBook() {
    const allWrong = wrongQuestions();
    if (!allWrong.length) {
      toast("暂无错题");
      renderHome();
      return;
    }
    if (el.viewChapters) {
      delete el.viewChapters.dataset.subject;
      el.viewChapters.dataset.mode = "wrong";
    }
    el.chapterTitle.textContent = "错题本";
    if (el.btnBackChapters) el.btnBackChapters.textContent = "返回首页";
    el.chapterList.innerHTML = "";

    {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chapter-item";
      item.dataset.wrongScope = "all";
      item.innerHTML = `
        <div class="left">
          <div class="name">全部错题</div>
          <div class="sub">全部分类 · 共 ${allWrong.length} 题</div>
        </div>
        <span class="badge">${allWrong.length}</span>
      `;
      item.addEventListener("click", () =>
        startSession(allWrong, { mode: "wrong", index: 0 })
      );
      el.chapterList.appendChild(item);
    }

    for (const s of meta.subjects) {
      const list = wrongQuestions(s.id);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chapter-item";
      item.dataset.wrongScope = s.id;
      item.dataset.subject = s.id;
      item.disabled = list.length === 0;
      item.innerHTML = `
        <div class="left">
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="sub">${
            list.length ? `本分类错题 · 共 ${list.length} 题` : "本分类暂无错题"
          }</div>
        </div>
        <span class="badge">${list.length}</span>
      `;
      if (list.length) {
        item.addEventListener("click", () =>
          startSession(list, { mode: "wrong", subject: s.id, index: 0 })
        );
      }
      el.chapterList.appendChild(item);
    }

    showView("chapters");
  }

  function startNotesBook() {
    const list = notedQuestions();
    if (!list.length) {
      toast("暂无笔记");
      return;
    }
    startSession(list, { mode: "notes", index: 0 });
  }

  function currentQ() {
    return session.list[session.index];
  }

  function renderQuestion(focusTarget, options) {
    const q = currentQ();
    if (!q) return;

    flushNoteSave();
    if (!options || options.rememberPosition !== false) rememberSessionPosition();

    const total = session.list.length;
    const idx = session.index + 1;
    const pct = Math.round((idx / total) * 100);
    const answerParts = getAnswerParts(q);
    if (el.viewQuiz) el.viewQuiz.dataset.subject = q.subject || "";
    el.quizProgress.style.width = pct + "%";
    el.quizProgressText.textContent = `${idx} / ${total}`;
    // ARIA 挂在填充条上（视觉进度指示）；外层 bar 仅作轨道容器
    const progressBar = el.quizProgress;
    progressBar.setAttribute("role", "progressbar");
    progressBar.setAttribute("aria-valuemin", "0");
    progressBar.setAttribute("aria-valuemax", "100");
    progressBar.setAttribute("aria-valuenow", String(pct));
    progressBar.setAttribute("aria-label", `答题进度：${idx} / ${total}`);

    const modeLabel =
      session.mode === "wrong"
        ? session.subject
          ? `错题本 · ${q.subjectName}`
          : "错题本"
        : session.mode === "notes"
          ? "笔记本"
          : session.mode === "subject"
            ? q.subjectName + (q.subject === "daily" ? " · 全部题目" : " · 整卷")
            : q.chapter;

    if (el.quizTitle) {
      el.quizTitle.textContent = `${q.subjectName} · ${modeLabel} · 第 ${q.number} 题`;
    }
    el.quizMeta.innerHTML = `
      <span class="quiz-subject-mark" aria-hidden="true"></span>
      <strong>${escapeHtml(q.subjectName)}</strong>
      <span class="quiz-meta-separator" aria-hidden="true">/</span>
      <span>${escapeHtml(modeLabel)} · 第 ${escapeHtml(q.number)} 题</span>
    `;
    if (el.questionGuideText) {
      el.questionGuideText.textContent = isSubjectiveQuestion(q)
        ? meta.subjectiveLabel || "综合应用题"
        : answerParts.length > 1
          ? `按顺序完成 ${answerParts.length} 个选择`
          : "选出最合适的一项";
    }
    if (el.shortcutHint) {
      el.shortcutHint.classList.toggle("hidden", isSubjectiveQuestion(q));
      el.shortcutHint.textContent = "键盘 A–D 也可作答";
    }

    el.stem.innerHTML = renderMarkdownLite(q.stem);
    renderMethodHint(q);
    if (window.QuizAI) window.QuizAI.setQuestion(q, { methods: methodsForQuestion(q) });
    el.options.innerHTML = "";
    el.feedback.classList.add("hidden");
    el.feedback.setAttribute("aria-hidden", "true");
    el.explanation.classList.add("hidden");
    el.explanation.setAttribute("aria-hidden", "true");
    if (el.postAnswer) el.postAnswer.classList.add("hidden");
    if (el.explanationPreview) {
      el.explanationPreview.classList.add("hidden");
      el.explanationPreview.innerHTML = "";
    }
    if (el.explanationBody) {
      el.explanationBody.classList.remove("hidden");
      el.explanationBody.innerHTML = "";
    }
    if (el.btnExplanationToggle) {
      el.btnExplanationToggle.classList.add("hidden");
      el.btnExplanationToggle.setAttribute("aria-expanded", "true");
    }
    hideNotePanel();

    const answered = session.mode === "wrong" ? session.attempts[q.id] : state.done[q.id];
    if (isSubjectiveQuestion(q)) {
      renderSubjectiveResponse(q, answered);
      if (answered) showResult(q, answered);
    } else {
      const partCount = answerParts.length || 1;
      if (answered) {
        for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
          renderOptionGroup(q, partIndex, answered);
        }
        showResult(q, answered);
      } else {
        const draft = session.drafts[q.id] || "";
        const partIndex = Math.min(draft.length, partCount - 1);
        renderOptionGroup(q, partIndex, null);
      }
    }
    if (answered) {
      // 笔记本模式：若已有笔记则默认展开，便于复习
      setupNotePanel(q, session.mode === "notes" && hasNote(q.id));
    } else if (session.mode === "notes" && hasNote(q.id)) {
      // Notes deliberately survive a progress reset, so notebook review must
      // not depend on this question still having an answer record.
      setupNotePanel(q, true);
    }

    el.btnPrev.disabled = session.index <= 0;
    el.btnNext.disabled = session.index >= session.list.length - 1;
    if (el.btnRetry) {
      el.btnRetry.classList.toggle("hidden", !answered);
      el.btnRetry.textContent = isSubjectiveQuestion(q) ? "重新作答" : "重做本题";
    }
    if (el.btnBackToChapters) {
      const canBackToChapters =
        session.mode === "wrong" ||
        ((session.mode === "subject" || session.mode === "chapter") && !!session.subject);
      el.btnBackToChapters.classList.toggle("hidden", !canBackToChapters);
      if (canBackToChapters) {
        el.btnBackToChapters.textContent =
          session.mode === "wrong" ? "返回错题本" : "返回分类";
      }
    }
    el.jumpInput.value = String(idx);
    el.jumpInput.max = String(total);

    installImageFallbacks(el.stem);
    installImageFallbacks(el.options);
    prepareScrollableTables(el.stem);
    prepareScrollableTables(el.options);
    typesetMath(el.stem);
    typesetMath(el.options);

    const target =
      focusTarget === "option"
        ? el.options.querySelector(".option:not(:disabled)")
        : focusTarget === "feedback"
          ? el.btnNextAnswer && !el.btnNextAnswer.classList.contains("hidden")
            ? el.btnNextAnswer
            : el.feedback
          : focusTarget === "note"
            ? el.noteInput
            : focusTarget === "question"
              ? el.quizTitle
            : null;
    if (target) {
      target.tabIndex = target.tabIndex < 0 ? -1 : target.tabIndex;
      target.focus({ preventScroll: true });
    }
    if (focusTarget === "question") {
      requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
    } else if (focusTarget === "option" && target) {
      requestAnimationFrame(() => target.scrollIntoView({ block: "nearest", behavior: "auto" }));
    }
    if (focusTarget === "feedback" && el.feedback) {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => {
        (el.postAnswer || el.feedback).scrollIntoView({
          block: "nearest",
          behavior: reduceMotion ? "auto" : "smooth",
        });
      });
    }
  }

  function getAnswerParts(q) {
    if (isSubjectiveQuestion(q)) return [];
    if (Array.isArray(q.answerParts) && q.answerParts.length) {
      return q.answerParts.map((part) => normalizeLetter(part));
    }
    const answer = normalizeLetter(q.answer);
    return answer ? [answer] : [];
  }

  function getOptionGroup(q, partIndex) {
    const configured = Array.isArray(q.optionGroups) ? q.optionGroups[partIndex] : null;
    return {
      label:
        configured && configured.label
          ? String(configured.label)
          : getAnswerParts(q).length > 1
            ? `第 ${partIndex + 1} 段`
            : "",
      options:
        configured && configured.options && typeof configured.options === "object"
          ? configured.options
          : q.options && typeof q.options === "object"
            ? q.options
            : {},
    };
  }

  function renderSubjectiveResponse(q, answered) {
    const wrapper = document.createElement("section");
    wrapper.className = "subjective-response";
    const heading = document.createElement("div");
    heading.className = "subjective-response-heading";
    heading.textContent = "我的作答";
    wrapper.appendChild(heading);

    if (answered) {
      const saved = document.createElement("div");
      saved.className = "subjective-response-saved";
      saved.innerHTML = answered.response
        ? renderMarkdownLite(answered.response)
        : '<span class="subjective-empty">未填写作答</span>';
      wrapper.appendChild(saved);
      el.options.appendChild(wrapper);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.className = "subjective-input";
    textarea.rows = 8;
    textarea.maxLength = RESPONSE_MAX_LEN;
    textarea.placeholder = "写下解题步骤、关键结论或最终答案…";
    textarea.value = session.drafts[q.id] || "";
    textarea.setAttribute("aria-label", "本题作答");
    textarea.addEventListener("input", () => {
      session.drafts[q.id] = textarea.value.slice(0, RESPONSE_MAX_LEN);
    });
    wrapper.appendChild(textarea);

    const actions = document.createElement("div");
    actions.className = "subjective-actions";
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "btn btn-primary";
    reveal.textContent = "查看参考答案";
    reveal.addEventListener("click", () => submitSubjectiveResponse(textarea.value));
    actions.appendChild(reveal);
    wrapper.appendChild(actions);
    el.options.appendChild(wrapper);
  }

  function submitSubjectiveResponse(response) {
    const q = currentQ();
    if (!q || !isSubjectiveQuestion(q)) return;
    const existing = session.mode === "wrong" ? session.attempts[q.id] : state.done[q.id];
    if (existing) return;
    const result = {
      choice: "REVIEWED",
      response: String(response || "").slice(0, RESPONSE_MAX_LEN),
      review: "pending",
      correct: null,
      ts: Date.now(),
    };
    if (session.mode === "wrong") session.attempts[q.id] = result;
    delete session.drafts[q.id];
    saveState((latest) => {
      latest.done[String(q.id)] = result;
    });
    renderQuestion("feedback");
  }

  function markSubjectiveReview(review) {
    if (!["mastered", "revisit"].includes(review)) return;
    const q = currentQ();
    if (!q || !isSubjectiveQuestion(q)) return;
    const result = session.mode === "wrong" ? session.attempts[q.id] : state.done[q.id];
    if (!result) return;
    const updated = { ...result, review, correct: null, ts: Date.now() };
    if (session.mode === "wrong") session.attempts[q.id] = updated;
    const questionId = String(q.id);
    saveState((latest) => {
      latest.done[questionId] = updated;
      if (review === "revisit") {
        if (!latest.wrong.includes(questionId)) latest.wrong.push(questionId);
      } else {
        latest.wrong = latest.wrong.filter((id) => id !== questionId);
      }
    });
    renderQuestion("feedback");
    toast(review === "mastered" ? "已标记为掌握" : "已加入错题本");
  }

  function renderOptionGroup(q, partIndex, answered) {
    const group = getOptionGroup(q, partIndex);
    const wrapper = document.createElement("section");
    wrapper.className = "option-group";
    wrapper.setAttribute("role", "group");
    if (group.label) {
      const label = document.createElement("div");
      label.className = "option-group-label";
      label.textContent = group.label;
      label.id = `quiz-option-group-label-${partIndex}`;
      wrapper.setAttribute("aria-labelledby", label.id);
      wrapper.appendChild(label);
    } else {
      wrapper.setAttribute("aria-label", "选项");
    }

    let letters = ["A", "B", "C", "D"].filter((letter) => group.options[letter] != null);
    if (!letters.length) letters = ["A", "B", "C", "D"];
    for (const letter of letters) {
      const text =
        group.options[letter] != null
          ? group.options[letter]
          : "（选项解析不完整，请结合题干选择）";
      wrapper.appendChild(makeOptionBtn(q, partIndex, letter, text, answered));
    }
    el.options.appendChild(wrapper);
  }

  function makeOptionBtn(q, partIndex, letter, text, answered) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option";
    btn.dataset.letter = letter;
    btn.dataset.partIndex = String(partIndex);
    btn.setAttribute("aria-keyshortcuts", `${letter} ${"ABCD".indexOf(letter) + 1}`);
    btn.innerHTML = `<span class="key">${letter}</span><span class="text">${renderMarkdownLite(
      text || ""
    )}</span>`;
    const optionImages = Array.from(btn.querySelectorAll(".text img"));
    optionImages.forEach((img, index) => {
      if (!img.getAttribute("alt") || img.alt === "题目配图") {
        img.alt =
          optionImages.length > 1
            ? `选项 ${letter} 第 ${index + 1} 张配图`
            : `选项 ${letter} 配图`;
      }
    });

    if (answered) {
      btn.disabled = true;
      applyOptionStyle(btn, letter, answered.choice.charAt(partIndex), getAnswerParts(q)[partIndex]);
    } else {
      btn.addEventListener("click", () => chooseOption(letter, partIndex));
    }
    return btn;
  }

  function applyOptionStyle(btn, letter, choice, answer) {
    if (answer && letter === answer) btn.classList.add("correct");
    if (letter === choice && answer && letter !== answer) btn.classList.add("wrong");
    if (letter === choice) btn.classList.add("selected");
    const stateLabel =
      answer && letter === answer ? "正确答案" : letter === choice ? "你的选择" : "";
    if (stateLabel) {
      const marker = document.createElement("span");
      marker.className = "option-state";
      marker.textContent = stateLabel;
      btn.appendChild(marker);
      const textNode = btn.querySelector(".text");
      const accessibleParts = [textNode?.textContent?.trim() || ""];
      if (textNode) {
        textNode.querySelectorAll("img").forEach((img) => accessibleParts.push(img.alt || "配图"));
      }
      btn.setAttribute(
        "aria-label",
        `${letter}，${accessibleParts.filter(Boolean).join("，")}，${stateLabel}`
      );
    }
  }

  function normalizeLetter(value) {
    const letter = String(value || "").trim().toUpperCase();
    return /^[A-D]$/.test(letter) ? letter : "";
  }

  function chooseOption(letter, partIndex) {
    const q = currentQ();
    if (!q) return;
    const button = el.options.querySelector(
      `.option:not(:disabled)[data-letter="${letter}"][data-part-index="${partIndex}"]`
    );
    if (!button) return;
    const answered = session.mode === "wrong" ? session.attempts[q.id] : state.done[q.id];
    if (answered) return;

    const answerParts = getAnswerParts(q);
    const partCount = answerParts.length || 1;
    const draft = session.drafts[q.id] || "";
    const expectedPart = Math.min(draft.length, partCount - 1);
    if (partIndex !== expectedPart) return;

    const choice = draft + letter;
    if (partIndex < partCount - 1) {
      session.drafts[q.id] = choice;
      renderQuestion("option");
      return;
    }
    submitAnswer(choice);
  }

  function submitAnswer(choice) {
    const q = currentQ();
    if (!q) return;
    const existing = session.mode === "wrong" ? session.attempts[q.id] : state.done[q.id];
    if (existing) return;

    const correct = correctnessForChoice(q, choice);
    const result = { choice, correct, ts: Date.now() };
    if (session.mode === "wrong") session.attempts[q.id] = result;
    delete session.drafts[q.id];

    const questionId = String(q.id);
    saveState((latest) => {
      latest.done[questionId] = result;
      if (correct === false) {
        if (!latest.wrong.includes(questionId)) latest.wrong.push(questionId);
      } else {
        latest.wrong = latest.wrong.filter((id) => id !== questionId);
      }
    });
    renderQuestion("feedback");
  }

  function hasNote(questionId) {
    const note = state.notes[questionId];
    return !!(note && String(note.text || "").trim());
  }

  function getNoteText(questionId) {
    const note = state.notes[questionId];
    return note ? String(note.text || "") : "";
  }

  function hideNotePanel() {
    if (!el.notePanel) return;
    el.notePanel.classList.add("hidden");
    el.notePanel.setAttribute("aria-hidden", "true");
    if (el.btnNoteToggle) el.btnNoteToggle.setAttribute("aria-expanded", "false");
    if (el.noteBody) el.noteBody.classList.add("hidden");
    if (el.noteSnippet) {
      el.noteSnippet.classList.add("hidden");
      el.noteSnippet.innerHTML = "";
    }
  }

  function setupNotePanel(q, forceOpen) {
    if (!el.notePanel || !q) return;
    const existing = getNoteText(q.id);
    const open = forceOpen || noteEditorOpen;
    noteEditorOpen = open;

    el.notePanel.classList.remove("hidden");
    el.notePanel.setAttribute("aria-hidden", "false");

    if (el.btnNoteToggle) {
      el.btnNoteToggle.textContent = open ? "收起" : existing ? "编辑笔记" : "写笔记";
      el.btnNoteToggle.setAttribute("aria-expanded", String(open));
    }

    if (el.noteInput) {
      el.noteInput.value = existing;
      el.noteInput.dataset.questionId = String(q.id);
    }

    if (open) {
      if (el.noteBody) el.noteBody.classList.remove("hidden");
      if (el.noteSnippet) {
        el.noteSnippet.classList.add("hidden");
        el.noteSnippet.innerHTML = "";
      }
      setNoteTab(notePreviewMode ? "preview" : "edit");
      updateNoteStatus(existing);
    } else {
      if (el.noteBody) el.noteBody.classList.add("hidden");
      if (el.noteSnippet) {
        if (existing) {
          el.noteSnippet.classList.remove("hidden");
          el.noteSnippet.innerHTML = renderNoteMarkdown(existing);
          typesetMath(el.noteSnippet);
        } else {
          el.noteSnippet.classList.add("hidden");
          el.noteSnippet.innerHTML = "";
        }
      }
    }
  }

  function setNoteTab(mode) {
    notePreviewMode = mode === "preview";
    if (!el.noteInput || !el.notePreview) return;
    if (notePreviewMode) {
      if (el.noteEditPanel) el.noteEditPanel.classList.add("hidden");
      else el.noteInput.classList.add("hidden");
      el.notePreview.classList.remove("hidden");
      el.notePreview.innerHTML = renderNoteMarkdown(el.noteInput.value);
      typesetMath(el.notePreview);
    } else {
      if (el.noteEditPanel) el.noteEditPanel.classList.remove("hidden");
      else el.noteInput.classList.remove("hidden");
      el.notePreview.classList.add("hidden");
    }
    if (el.btnNoteEdit) {
      el.btnNoteEdit.classList.toggle("active", !notePreviewMode);
      el.btnNoteEdit.setAttribute("aria-selected", String(!notePreviewMode));
      el.btnNoteEdit.tabIndex = notePreviewMode ? -1 : 0;
    }
    if (el.btnNotePreviewTab) {
      el.btnNotePreviewTab.classList.toggle("active", notePreviewMode);
      el.btnNotePreviewTab.setAttribute("aria-selected", String(notePreviewMode));
      el.btnNotePreviewTab.tabIndex = notePreviewMode ? 0 : -1;
    }
  }

  function handleNoteTabKeydown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [el.btnNoteEdit, el.btnNotePreviewTab].filter(Boolean);
    if (tabs.length < 2) return;
    event.preventDefault();
    let index = tabs.indexOf(event.currentTarget);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
    else index = (index - 1 + tabs.length) % tabs.length;
    setNoteTab(index === 0 ? "edit" : "preview");
    tabs[index].focus();
  }

  function updateNoteStatus(text, saved) {
    if (!el.noteStatus) return;
    const value = text == null && el.noteInput ? el.noteInput.value : text || "";
    const len = String(value).length;
    const questionId = el.noteInput ? el.noteInput.dataset.questionId : "";
    const isSaved = saved !== false && !unsavedNoteIds.has(questionId);
    if (!isSaved) {
      el.noteStatus.textContent = `未保存 · 仅本页保留 · ${len}/${NOTE_MAX_LEN}`;
    } else if (!String(value).trim()) {
      el.noteStatus.textContent = `自动保存 · Markdown / $公式$ · ${len}/${NOTE_MAX_LEN}`;
    } else {
      el.noteStatus.textContent = `已保存 · ${len}/${NOTE_MAX_LEN}`;
    }
  }

  function scheduleNoteSave() {
    if (!el.noteInput) return;
    const questionId = el.noteInput.dataset.questionId;
    if (!questionId) return;
    const text = el.noteInput.value.slice(0, NOTE_MAX_LEN);
    pendingNote = { id: questionId, text };
    if (el.noteStatus) el.noteStatus.textContent = "保存中…";
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
      flushNoteSave();
    }, 350);
  }

  function flushNoteSave() {
    clearTimeout(noteSaveTimer);
    noteSaveTimer = null;
    if (!pendingNote) return;
    const { id, text } = pendingNote;
    pendingNote = null;
    persistNote(id, text);
  }

  function persistNote(questionId, text) {
    const clipped = String(text || "").slice(0, NOTE_MAX_LEN);
    const saved = saveState((latest) => {
      if (!clipped.trim()) {
        delete latest.notes[questionId];
      } else {
        latest.notes[questionId] = { text: clipped, updatedAt: Date.now() };
      }
    });
    if (saved) unsavedNoteIds.delete(questionId);
    else unsavedNoteIds.add(questionId);
    if (el.noteInput && el.noteInput.dataset.questionId === String(questionId)) {
      updateNoteStatus(clipped, saved);
    }
    if (el.btnNotes && !el.viewHome.classList.contains("hidden")) {
      el.btnNotes.disabled = notedQuestions().length === 0;
    }
  }

  function toggleNoteEditor() {
    const q = currentQ();
    if (!q) return;
    const answered = session.mode === "wrong" ? session.attempts[q.id] : state.done[q.id];
    if (!answered && !(session.mode === "notes" && hasNote(q.id))) return;
    if (noteEditorOpen) {
      flushNoteSave();
      noteEditorOpen = false;
      setupNotePanel(q, false);
    } else {
      noteEditorOpen = true;
      notePreviewMode = false;
      setupNotePanel(q, true);
      if (el.noteInput) el.noteInput.focus({ preventScroll: true });
    }
  }

  function clearCurrentNote() {
    const q = currentQ();
    if (!q || !el.noteInput) return;
    if (!el.noteInput.value.trim() && !hasNote(q.id)) {
      toast("当前没有笔记");
      return;
    }
    if (!confirm("确定清空本题笔记？")) return;
    el.noteInput.value = "";
    pendingNote = { id: String(q.id), text: "" };
    flushNoteSave();
    setNoteTab(notePreviewMode ? "preview" : "edit");
    updateNoteStatus("");
    toast("笔记已清空");
  }

  function explanationTextLength(source) {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdownLite(source || "");
    return String(container.textContent || "").replace(/\s+/g, "").length;
  }

  function emphasizeExplanationLead(block) {
    return block
      .replace(
        /^((?:【[^】]{1,32}】|(?:方法|步骤|结论|易错点|注意)[^<：:]{0,24}[：:]))/,
        '<strong class="explanation-lead">$1</strong>'
      )
      .replace(
        /^((?:I{1,4}|[A-D])\s*(?:正确|错误)[，,:：]?)/,
        '<strong class="explanation-lead">$1</strong>'
      );
  }

  function renderExplanationContent(source) {
    if (!source) return '<p class="explanation-empty">暂无解析文本。</p>';
    const container = document.createElement("div");
    container.innerHTML = renderMarkdownLite(source);
    const lines = [];
    let inlineNodes = [];
    const pushLine = () => {
      const wrapper = document.createElement("div");
      for (const node of inlineNodes) wrapper.appendChild(node.cloneNode(true));
      lines.push({ type: "line", html: wrapper.innerHTML });
      inlineNodes = [];
    };

    for (const node of Array.from(container.childNodes)) {
      const isElement = node.nodeType === Node.ELEMENT_NODE;
      if (isElement && node.tagName === "BR") {
        pushLine();
        continue;
      }
      const isMedia =
        isElement &&
        (node.matches(".table-scroll, img, .image-placeholder, .content-code") ||
          node.tagName === "TABLE");
      if (isMedia) {
        if (inlineNodes.length) pushLine();
        lines.push({ type: "media", html: node.outerHTML });
        continue;
      }
      inlineNodes.push(node);
    }
    if (inlineNodes.length) pushLine();

    const out = [];
    let paragraph = [];
    let listType = "";
    let listItems = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const html = paragraph.join("<br>");
      out.push(`<div class="explanation-block">${emphasizeExplanationLead(html)}</div>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!listItems.length) return;
      const tag = listType === "ol" ? "ol" : "ul";
      out.push(
        `<${tag} class="explanation-list">${listItems
          .map((item) => `<li>${item}</li>`)
          .join("")}</${tag}>`
      );
      listType = "";
      listItems = [];
    };

    for (const line of lines) {
      if (line.type === "media") {
        flushParagraph();
        flushList();
        out.push(`<div class="explanation-media-block">${line.html}</div>`);
        continue;
      }
      const html = line.html.trim();
      if (!html) {
        flushParagraph();
        continue;
      }
      const heading = html.match(/^#{1,4}\s+([\s\S]+)$/);
      const stepHeading = html.match(/^[a-z][.、]\s+[\s\S]+[：:]$/);
      if (heading || stepHeading) {
        flushParagraph();
        flushList();
        out.push(`<h5 class="explanation-subheading">${heading ? heading[1] : html}</h5>`);
        continue;
      }
      const bullet = html.match(/^(?:\\?[-*]|[➢•])\s+([\s\S]+)$/);
      const ordered = html.match(/^\d+[.、]\s+([\s\S]+)$/);
      if (bullet || ordered) {
        flushParagraph();
        const nextListType = ordered ? "ol" : "ul";
        if (listType && listType !== nextListType) flushList();
        listType = nextListType;
        listItems.push((bullet || ordered)[1]);
        continue;
      }
      flushList();
      paragraph.push(html);
    }
    flushParagraph();
    flushList();
    return out.join("");
  }

  function renderAnswerPreview(q) {
    if (isSubjectiveQuestion(q)) {
      return `
        <span class="preview-label">参考答案</span>
        <p class="preview-prompt">展开查看完整解答，再标记掌握情况。</p>
      `;
    }
    const answers = getAnswerParts(q);
    if (!answers.length) {
      return `
        <span class="preview-label">先核对题意</span>
        <p class="preview-prompt">本题暂无标准答案，请展开解析自行判断。</p>
      `;
    }
    const rows = answers
      .map((letter, partIndex) => {
        const group = getOptionGroup(q, partIndex);
        const optionText = group.options[letter] || "（正确选项文本缺失）";
        const groupLabel = answers.length > 1 ? group.label || `第 ${partIndex + 1} 段` : "";
        return `
          <div class="answer-summary-row">
            <span class="answer-summary-key">${escapeHtml(letter)}</span>
            <div class="answer-summary-copy">
              ${groupLabel ? `<strong>${escapeHtml(groupLabel)}</strong>` : ""}
              <span>${renderMarkdownLite(optionText)}</span>
            </div>
          </div>
        `;
      })
      .join("");
    return `
      <span class="preview-label">先看答案</span>
      <div class="answer-summary-list">${rows}</div>
      <p class="preview-prompt">想知道为什么选它，再展开完整推导。</p>
    `;
  }

  function setExplanationExpanded(expanded) {
    if (!el.explanationBody || !el.explanationPreview || !el.btnExplanationToggle) return;
    const collapsible = el.btnExplanationToggle.dataset.collapsible === "true";
    const showFull = !collapsible || expanded;
    el.explanationBody.classList.toggle("hidden", !showFull);
    el.explanationPreview.classList.toggle("hidden", showFull);
    el.btnExplanationToggle.classList.toggle("hidden", !collapsible);
    el.btnExplanationToggle.setAttribute("aria-expanded", String(showFull));
    el.btnExplanationToggle.textContent = showFull ? "收起解析" : "展开完整解析";
    if (showFull) prepareScrollableTables(el.explanationBody);
  }

  function toggleExplanation() {
    if (!el.btnExplanationToggle) return;
    const expanded = el.btnExplanationToggle.getAttribute("aria-expanded") === "true";
    setExplanationExpanded(!expanded);
  }

  function nextFromAnswer() {
    if (session.index >= session.list.length - 1) {
      flushNoteSave();
      noteEditorOpen = false;
      notePreviewMode = false;
      renderHome();
      return;
    }
    go(1);
  }

  function showResult(q, result) {
    el.feedback.classList.remove("hidden", "ok", "bad", "neutral");
    el.feedback.classList.toggle("subjective", isSubjectiveQuestion(q));
    el.feedback.setAttribute("aria-hidden", "false");
    el.feedback.tabIndex = -1;
    const answers = getAnswerParts(q);
    const answerLabel = answers.join(" / ");
    let icon = "•";
    let title = "已记录选择";
    let detail = "本题暂无标准答案";

    if (isSubjectiveQuestion(q)) {
      el.feedback.classList.add("neutral");
      if (result.review === "mastered") {
        icon = "✓";
        title = "已标记为掌握";
      } else if (result.review === "revisit") {
        icon = "↺";
        title = "已加入错题本";
      } else {
        title = "参考答案已就绪";
      }
      detail = result.response ? "你的作答已保存" : "本次未填写作答";
    } else if (result.correct === null) {
      const choiceLabel = result.choice.split("").join(" / ");
      el.feedback.classList.add("neutral");
      detail = `你选了 ${choiceLabel} · 本题暂无标准答案`;
    } else if (result.correct) {
      el.feedback.classList.add("ok");
      icon = "✓";
      title = "回答正确";
      detail = `答案 ${answerLabel}`;
    } else {
      const choiceLabel = result.choice.split("").join(" / ");
      el.feedback.classList.add("bad");
      icon = "×";
      title = "回答错误";
      detail = `你选 ${choiceLabel} · 正确答案 ${answerLabel}`;
    }
    el.feedback.innerHTML = `
      <span class="feedback-icon" aria-hidden="true">${icon}</span>
      <span class="feedback-copy"><strong>${title}</strong><span>${detail}</span></span>
    `;
    if (isSubjectiveQuestion(q)) {
      const controls = document.createElement("div");
      controls.className = "subjective-review-actions";
      controls.innerHTML = `
        <button type="button" class="btn${result.review === "mastered" ? " active" : ""}" data-review="mastered" aria-pressed="${result.review === "mastered"}">已掌握</button>
        <button type="button" class="btn${result.review === "revisit" ? " active" : ""}" data-review="revisit" aria-pressed="${result.review === "revisit"}">需重做</button>
      `;
      controls.querySelectorAll("[data-review]").forEach((button) => {
        button.addEventListener("click", () => markSubjectiveReview(button.dataset.review));
      });
      el.feedback.appendChild(controls);
    }

    if (el.postAnswer) el.postAnswer.classList.remove("hidden");
    if (el.postAnswerHint) {
      el.postAnswerHint.textContent = isSubjectiveQuestion(q)
        ? result.review === "pending"
          ? "核对解法后，标记本题掌握情况。"
          : result.review === "mastered"
            ? "已掌握，可以继续下一题。"
            : "已保留在错题本，复盘后再做一次。"
        : result.correct === false
          ? "先确认正确选项，再展开推导找出分岔点。"
          : result.correct === true
            ? "这题已拿下；确认思路或趁热继续都可以。"
            : "结合解析核对后，再继续下一题。";
    }
    if (el.btnNextAnswer) {
      el.btnNextAnswer.innerHTML =
        session.index >= session.list.length - 1
          ? '完成本组 <span aria-hidden="true">✓</span>'
          : '下一题 <span aria-hidden="true">→</span>';
    }

    const source = q.explanation || "";
    const textLength = explanationTextLength(source);
    const hasStructuredContent = /<table\b|!\[[^\]]*\]\(/i.test(source);
    const isCollapsible = textLength > EXPLANATION_COLLAPSE_LENGTH || hasStructuredContent;
    const minutes = Math.max(1, Math.ceil(textLength / 700));
    el.explanation.classList.remove("hidden");
    el.explanation.setAttribute("aria-hidden", "false");
    if (el.explanationMeta) {
      el.explanationMeta.textContent = isCollapsible
        ? `${textLength > 1000 || hasStructuredContent ? "深度解析" : "完整解析"} · 约 ${minutes} 分钟`
        : "简短解析";
    }
    el.explanationBody.innerHTML = renderExplanationContent(source);
    el.explanationPreview.innerHTML = renderAnswerPreview(q);
    el.btnExplanationToggle.dataset.collapsible = String(isCollapsible);
    setExplanationExpanded(!isCollapsible);
    installImageFallbacks(el.explanationBody);
    installImageFallbacks(el.explanationPreview);
    prepareScrollableTables(el.explanationBody);
    prepareScrollableTables(el.explanationPreview);
    typesetMath(el.explanationBody);
    typesetMath(el.explanationPreview);
  }

  function go(delta) {
    const next = session.index + delta;
    if (next < 0 || next >= session.list.length) return;
    flushNoteSave();
    noteEditorOpen = false;
    notePreviewMode = false;
    session.index = next;
    renderQuestion("question");
  }

  function jumpTo() {
    const n = parseInt(el.jumpInput.value, 10);
    if (!n || n < 1 || n > session.list.length) {
      toast("题号超出范围");
      return;
    }
    flushNoteSave();
    noteEditorOpen = false;
    notePreviewMode = false;
    session.index = n - 1;
    renderQuestion("question");
  }

  function resetProgress() {
    if (!activeBank) return;
    if (
      !confirm(
        `确定清空「${activeBank.name}」的做题进度和错题本？笔记会保留，其他题库不受影响。此操作不可恢复。`
      )
    ) {
      return;
    }
    flushNoteSave();
    saveState((latest) => {
      latest.done = {};
      latest.wrong = [];
      latest.last = null;
    });
    renderHome();
    toast("进度已清空（笔记已保留）");
  }

  /* ---- lightweight markdown for stem/options/explanation ---- */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderMarkdownLite(src) {
    if (!src) return "";
    let s = String(src);

    // Protect math blocks and images temporarily
    const slots = [];
    const park = (html) => {
      slots.push(html);
      return `%%SLOT${slots.length - 1}%%`;
    };

    s = s.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, language, code) => {
      const languageLabel = String(language || "").trim();
      return park(
        `<pre class="content-code"${languageLabel ? ` data-language="${escapeHtml(languageLabel)}"` : ""}><code>${escapeHtml(
          String(code).replace(/\n$/, "")
        )}</code></pre>`
      );
    });

    // Converted question data may contain HTML tables. Only restore a small,
    // attribute-limited whitelist after the surrounding source is escaped.
    s = s.replace(/<table\b[\s\S]*?<\/table>/gi, (table) =>
      park(`<div class="table-scroll">${sanitizeTableHtml(table)}</div>`)
    );

    // images
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, srcUrl) => {
      const url = srcUrl.trim();
      const safeUrl = safeImageUrl(url);
      if (!safeUrl) return park(imagePlaceholderHtml(alt || "图片"));
      return park(
        `<img src="${escapeHtml(safeUrl)}" alt="${escapeHtml(alt || "题目配图")}" loading="lazy" />`
      );
    });

    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const safeUrl = safeLinkUrl(href.trim());
      // Invalid/ambiguous Markdown must remain visible as text. Dropping the
      // parenthesized part silently changed source notation such as
      // "x[3](第4块)" into just "x3".
      if (!safeUrl) return `[${label}](${href})`;
      return park(
        `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      );
    });

    // display math $$...$$
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => park(`$$${escapeHtml(m)}$$`));
    // inline math $...$
    s = s.replace(/\$([^\$\n]+?)\$/g, (_, m) => park(`$${escapeHtml(m)}$`));

    s = escapeHtml(s);

    // 加粗在转义之后再处理：此时数学、图片、代码都已经存进 slot，
    // 星号只可能来自正文，不会误伤公式里的乘号。
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

    // Convert plain-text newlines before restoring slots. Math/image/table
    // slots must keep real newlines so multi-line $$...$$ stays a single
    // text stream for KaTeX (turning them into <br> splits delimiters).
    s = s.replace(/\n/g, "<br>");
    s = s.replace(/%%SLOT(\d+)%%/g, (m, i) => slots[Number(i)] || escapeHtml(m));
    return s;
  }

  /** 笔记用：在轻量 Markdown 上增加标题/列表/加粗/代码，并保留数学公式 */
  function renderNoteMarkdown(src) {
    if (!src || !String(src).trim()) {
      return '<p class="note-empty">（空笔记）</p>';
    }
    let s = String(src);
    const slots = [];
    const park = (html) => {
      slots.push(html);
      return `%%SLOT${slots.length - 1}%%`;
    };

    s = s.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, _lang, code) =>
      park(`<pre class="note-code"><code>${escapeHtml(String(code).replace(/\n$/, ""))}</code></pre>`)
    );
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => park(`$$${escapeHtml(m)}$$`));
    s = s.replace(/\$([^\$\n]+?)\$/g, (_, m) => park(`$${escapeHtml(m)}$`));
    s = s.replace(/`([^`\n]+)`/g, (_, code) =>
      park(`<code class="note-inline-code">${escapeHtml(code)}</code>`)
    );

    s = escapeHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

    const lines = s.split("\n");
    const out = [];
    let inList = false;
    const closeList = () => {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
    };

    for (const line of lines) {
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        closeList();
        const level = heading[1].length + 3; // h4–h6
        out.push(`<h${level} class="note-heading">${heading[2]}</h${level}>`);
        continue;
      }
      const listItem = line.match(/^[-*]\s+(.+)$/);
      if (listItem) {
        if (!inList) {
          out.push('<ul class="note-list">');
          inList = true;
        }
        out.push(`<li>${listItem[1]}</li>`);
        continue;
      }
      closeList();
      if (line.trim() === "") {
        out.push("<br>");
      } else {
        out.push(`${line}<br>`);
      }
    }
    closeList();

    s = out.join("");
    s = s.replace(/%%SLOT(\d+)%%/g, (m, i) => slots[Number(i)] || escapeHtml(m));
    return s;
  }

  function sanitizeTableHtml(source) {
    const allowed = new Set([
      "TABLE",
      "CAPTION",
      "THEAD",
      "TBODY",
      "TFOOT",
      "TR",
      "TH",
      "TD",
      "BR",
      "STRONG",
      "EM",
      "CODE",
      "SUB",
      "SUP",
    ]);
    const documentNode = new DOMParser().parseFromString(source, "text/html");
    const table = documentNode.body.querySelector("table");
    if (!table) return escapeHtml(source);

    const serialize = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue || "");
      if (node.nodeType !== Node.ELEMENT_NODE || !allowed.has(node.tagName)) {
        return Array.from(node.childNodes || [], serialize).join("");
      }
      const tag = node.tagName.toLowerCase();
      const attributes = [];
      if (node.tagName === "TH" || node.tagName === "TD") {
        for (const name of ["colspan", "rowspan"]) {
          const value = node.getAttribute(name);
          if (/^[1-9]\d?$/.test(value || "")) attributes.push(`${name}="${value}"`);
        }
      }
      if (node.tagName === "TH") {
        const scope = node.getAttribute("scope");
        if (["row", "col", "rowgroup", "colgroup"].includes(scope)) {
          attributes.push(`scope="${scope}"`);
        }
      }
      const children = Array.from(node.childNodes, serialize).join("");
      const attrs = attributes.length ? " " + attributes.join(" ") : "";
      return node.tagName === "BR"
        ? "<br>"
        : `<${tag}${attrs}>${children}</${tag}>`;
    };

    return serialize(table);
  }

  function safeImageUrl(source) {
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(source)) return source;
    const resolved = resolveAssetUrl(source);
    try {
      const url = new URL(resolved, window.location.href);
      return ["http:", "https:", "file:", "blob:"].includes(url.protocol) ? resolved : "";
    } catch (_) {
      return "";
    }
  }

  function safeLinkUrl(source) {
    const raw = String(source || "").trim();
    if (!raw || raw.includes("\\")) return "";
    const absoluteLike =
      /^[a-z][a-z0-9+.-]*:/i.test(raw) ||
      raw.startsWith("//") ||
      raw.startsWith("/") ||
      raw.startsWith("#") ||
      raw.startsWith("?");
    // Question text such as "[38MB, 46MB](9MB)" is an interval followed by
    // its size, not a Markdown link. Relative document links must look like a
    // path or filename instead of accepting every parenthesized word.
    const relativeDocument = /^(?:\.{1,2}\/|[^/?#]+\/|[^/?#]+\.[A-Za-z0-9]{1,16}(?:[?#]|$))/.test(raw);
    if (!absoluteLike && !relativeDocument) return "";
    const resolved = resolveAssetUrl(raw);
    try {
      const url = new URL(resolved, window.location.href);
      return ["http:", "https:", "file:"].includes(url.protocol) ? resolved : "";
    } catch (_) {
      return "";
    }
  }

  function imagePlaceholderHtml(label) {
    return `<span class="image-placeholder" role="img" aria-label="图片加载失败">${escapeHtml(
      `图片加载失败：${label}`
    )}</span>`;
  }

  function installImageFallbacks(root) {
    if (!root) return;
    root.querySelectorAll("img").forEach((img) => {
      const replace = () => {
        if (!img.isConnected) return;
        const placeholder = document.createElement("span");
        placeholder.className = "image-placeholder";
        placeholder.setAttribute("role", "img");
        placeholder.setAttribute("aria-label", "图片加载失败");
        placeholder.textContent = `图片加载失败：${img.alt || "题目图片"}`;
        img.replaceWith(placeholder);
      };
      img.addEventListener("error", replace, { once: true });
      if (img.complete && img.naturalWidth === 0) replace();
    });
  }

  function prepareScrollableTables(root) {
    if (!root) return;
    root.querySelectorAll(".table-scroll").forEach((wrapper) => {
      const update = () => {
        if (!wrapper.isConnected) return;
        const isScrollable =
          wrapper.clientWidth > 0 && wrapper.scrollWidth > wrapper.clientWidth + 1;
        wrapper.classList.toggle("is-scrollable", isScrollable);
        if (isScrollable) {
          wrapper.tabIndex = 0;
          wrapper.setAttribute("role", "region");
          wrapper.setAttribute("aria-label", "表格，可横向滚动查看");
        } else {
          wrapper.removeAttribute("tabindex");
          wrapper.removeAttribute("role");
          wrapper.removeAttribute("aria-label");
        }
      };
      if (window.ResizeObserver && !tableResizeObservers.has(wrapper)) {
        const observer = new ResizeObserver(update);
        observer.observe(wrapper);
        tableResizeObservers.set(wrapper, observer);
      }
      requestAnimationFrame(update);
    });
  }

  function typesetMath(root) {
    if (!window.renderMathInElement || !root) return;
    try {
      window.renderMathInElement(root, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    } catch (_) {}
  }

  function configureAccessibility() {
    if (el.feedback) {
      el.feedback.setAttribute("role", "status");
      el.feedback.setAttribute("aria-live", "polite");
      el.feedback.setAttribute("aria-atomic", "true");
    }
    if (el.toast) {
      el.toast.setAttribute("role", "status");
      el.toast.setAttribute("aria-live", "assertive");
      el.toast.setAttribute("aria-atomic", "true");
    }
    if (el.quizProgressText) {
      el.quizProgressText.setAttribute("aria-live", "polite");
      el.quizProgressText.setAttribute("aria-atomic", "true");
    }
  }

  /* ---- keyboard ---- */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (window.QuizAI && window.QuizAI.handleEscape()) {
        e.preventDefault();
        return;
      }
    }
    if (el.viewQuiz.classList.contains("hidden")) return;
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (
      e.target instanceof Element &&
      e.target.closest(
        "input, textarea, select, [contenteditable='true'], #ai-panel, #ai-settings"
      )
    ) {
      return;
    }

    const key = e.key.toUpperCase();
    if (["A", "B", "C", "D", "1", "2", "3", "4"].includes(key)) {
      const map = { 1: "A", 2: "B", 3: "C", 4: "D", A: "A", B: "B", C: "C", D: "D" };
      const letter = map[key];
      const button = el.options.querySelector(
        `.option:not(:disabled)[data-letter="${letter}"]`
      );
      if (button) {
        e.preventDefault();
        button.click();
      }
      return;
    }
    if (key === "N" || e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (key === "P" || e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    }
  });

  /* ---- events ---- */
  el.btnHome.addEventListener("click", () => {
    flushNoteSave();
    noteEditorOpen = false;
    notePreviewMode = false;
    renderHome();
  });
  el.btnBackChapters.addEventListener("click", () => {
    flushNoteSave();
    renderHome();
  });
  if (el.btnBackToChapters) {
    el.btnBackToChapters.addEventListener("click", backToChaptersFromQuiz);
  }
  if (el.btnRetry) el.btnRetry.addEventListener("click", retryCurrentQuestion);
  el.btnContinue.addEventListener("click", continueLast);
  el.btnWrong.addEventListener("click", openWrongBook);
  if (el.btnNotes) el.btnNotes.addEventListener("click", startNotesBook);
  el.btnReset.addEventListener("click", resetProgress);
  el.btnTheme.addEventListener("click", toggleTheme);
  el.btnPrev.addEventListener("click", () => go(-1));
  el.btnNext.addEventListener("click", () => go(1));
  if (el.btnNextAnswer) el.btnNextAnswer.addEventListener("click", nextFromAnswer);
  if (el.btnExplanationToggle) {
    el.btnExplanationToggle.addEventListener("click", toggleExplanation);
  }
  el.btnJump.addEventListener("click", jumpTo);
  el.jumpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpTo();
  });
  if (el.btnNoteToggle) el.btnNoteToggle.addEventListener("click", toggleNoteEditor);
  if (el.btnNoteEdit) el.btnNoteEdit.addEventListener("click", () => setNoteTab("edit"));
  if (el.btnNotePreviewTab) {
    el.btnNotePreviewTab.addEventListener("click", () => {
      flushNoteSave();
      setNoteTab("preview");
    });
  }
  if (el.btnNoteClear) el.btnNoteClear.addEventListener("click", clearCurrentNote);
  if (el.noteInput) {
    el.noteInput.addEventListener("input", scheduleNoteSave);
    el.noteInput.addEventListener("blur", flushNoteSave);
  }
  if (el.btnNoteEdit) el.btnNoteEdit.addEventListener("keydown", handleNoteTabKeydown);
  if (el.btnNotePreviewTab) {
    el.btnNotePreviewTab.addEventListener("keydown", handleNoteTabKeydown);
  }
  window.addEventListener("pagehide", flushNoteSave);
  window.addEventListener("storage", (event) => {
    if (!activeBank || !STORAGE_KEY) return;
    if (event.key !== STORAGE_KEY || storageWriteFailed || unsavedNoteIds.size) return;
    // 错题本模式下避免列表与 state.wrong 脱节
    if (session.mode === "wrong") return;
    const visibleQuestion =
      !el.viewQuiz.classList.contains("hidden") ? currentQ() : null;
    const previousResult = visibleQuestion ? state.done[visibleQuestion.id] : null;
    try {
      state = event.newValue
        ? normalizeStoredState(JSON.parse(event.newValue))
        : emptyState();
    } catch (_) {
      showStorageWarning("其他标签页写入的进度无法读取，已保留当前页面状态");
      return;
    }
    if (visibleQuestion) {
      const nextResult = state.done[visibleQuestion.id];
      const previousKey = previousResult
        ? `${previousResult.choice}|${String(previousResult.correct)}|${previousResult.review || ""}`
        : "";
      const nextKey = nextResult
        ? `${nextResult.choice}|${String(nextResult.correct)}|${nextResult.review || ""}`
        : "";
      if (previousKey !== nextKey) {
        delete session.drafts[visibleQuestion.id];
        renderQuestion(null, { rememberPosition: false });
      }
    }
  });

  if (el.btnBanks) el.btnBanks.addEventListener("click", () => showBankChooser());
  if (el.btnMethods) el.btnMethods.addEventListener("click", openMethodCenter);
  if (el.btnBackMethods) el.btnBackMethods.addEventListener("click", renderHome);
  if (el.btnAi) {
    el.btnAi.addEventListener("click", () => {
      if (!window.QuizAI) {
        toast("AI 模块未加载");
        return;
      }
      window.QuizAI.toggle();
    });
  }

  applyTheme(document.documentElement.dataset.theme, false);
  configureAccessibility();
  if (pendingStorageWarning) showStorageWarning(pendingStorageWarning);

  if (window.QuizAI) {
    window.QuizAI.init({
      toast,
      escapeHtml,
      typesetMath,
      onOpen: () => {
        const q = currentQ();
        if (q) window.QuizAI.setQuestion(q, { methods: methodsForQuestion(q) });
      },
    });
  }

  function startApp() {
    if (!banks.length) {
      showBankChooser();
      return;
    }
    let lastBankId = "";
    try {
      lastBankId = localStorage.getItem(LAST_BANK_KEY) || "";
    } catch (_) {}
    // 旧程序的进度先迁移，题库卡片才能一上来就显示真实数字
    banks.forEach(runLegacyImport);
    renderBankChooser();
    updateTopbar();
    // 独立页面题库不自动恢复：否则上次刷过它，这里一打开就会被弹去那一页，回不到题库列表。
    const lastBank = lastBankId ? bankById(lastBankId) : null;
    if (lastBank && !isExternalBank(lastBank)) {
      showView("banks");
      selectBank(lastBankId, { silent: true });
      return;
    }
    showBankChooser();
  }

  startApp();
})();
