 /* =========================================================
 🧩 台語語音 / 手寫輸入工架構
 ---------------------------------------------------------
 架構總覽：

 1. 🔑 API Key 管理（localStorage）
 2. 🎙 語音辨識（Google Speech API）
 3. ✍️ 手寫辨識（Google Input Tools + Vision fallback）
 4. ⭐ 我的最愛 / 其他功能選單
 5. 📘 使用說明（Notion iframe + 本地 fallback）
 6. 🧓 極簡模式 / 🛠 進階模式切換
 7. 👪 家庭設定（給家人管理用）

 👉 快速導覽（Ctrl/Cmd + F）：
 - 語音：startBtn.onclick
 - 手寫：openHandwrite / hwRecognizeBtn
 - 最愛：renderFavoritesBar
 - 說明：openHelp / tryLoadHelpIframe
 ========================================================= */
 


// 🔑 API 憑證（只需輸入一次，會保存在 localStorage）
// 你可以用下方「🔑 API 憑證」輸入並儲存，之後不用再輸入。
let API_KEY = "";
try { API_KEY = (localStorage.getItem("googleApiKey") || "").trim(); } catch(e) {}

function setApiKey(newKey) {
  API_KEY = (newKey || "").trim();
  try {
    if (API_KEY) localStorage.setItem("googleApiKey", API_KEY);
    else localStorage.removeItem("googleApiKey");
  } catch(e) {}
  updateApiKeyUI();
}

function requireApiKey() {
  if (API_KEY && API_KEY.length > 10) return true;
  alert("尚未設定 API 憑證（API Key）。請先在下方『🔑 API 憑證』欄位輸入並儲存。");
  try { document.getElementById("apiKeyInput")?.focus(); } catch(e) {}
  return false;
}


let mediaRecorder;
let audioChunks = [];
let currentAudioStream = null;  // 👉 記住目前麥克風串流


/* =========================
   🎵／📈 專用詞庫（歌名／歌手／股票）
   - 可自行加更多
   - 用來：
     1) 提供給 Google STT 當 speechContext（提高辨識率）
     2) STT 回來後，做整句「標準漢字」替換
   ========================= */

// 1. 定義詞庫：以「你希望顯示的漢字句子」為主
//    key: 任意標識（不重要）
//    hanji: 顯示在畫面／YouTube 搜尋用的標準漢字
//    alias: 可能的口語說法（可不填）
const DOMAIN_ENTRIES = [
  {
    key: "jody-wine",
    hanji: "江蕙 酒後的心聲",
    alias: ["江蕙 酒後的心聲", "酒後的心聲", "江蕙的酒後的心聲"]
  },
  {
    key: "huang-y-ling",
    hanji: "黃乙玲 無字的情批",
    alias: ["黃乙玲 無字的情批", "無字的情批"]
  },
  {
    key: "taiwan-hero",
    hanji: "洪榮宏 舞女",
    alias: ["洪榮宏 舞女", "舞女"]
  },
  // 📈 股票 & ETF
  {
    key: "tsmc",
    hanji: "台積電 股票",
    alias: ["台積電", "2330", "台積電股票"]
  },
  {
    key: "0050",
    hanji: "元大台灣50 ETF 0050",
    alias: ["0050", "台灣50", "元大台灣50"]
  },
  {
    key: "006208",
    hanji: "富邦台50 ETF 006208",
    alias: ["006208", "富邦台50"]
  }
  // 👉 之後你可以慢慢增加這裡的條目
];

// 2. 幫 Google STT 準備 phrases 清單（拿來做 speechContexts）
const DOMAIN_PHRASES = (() => {
  const set = new Set();
  DOMAIN_ENTRIES.forEach(e => {
    if (e.hanji) set.add(e.hanji);
    (e.alias || []).forEach(a => set.add(a));
  });
  return Array.from(set);
})();

// 3. 規範化文字，方便比對（全部小寫、移除空白／符號）
function normalizeTextForDict(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "")        // 去掉所有空白
    .replace(/[^\p{L}\p{N}]+/gu, ""); // 去掉標點符號，只留字母數字
}

// 4. 建立「normalized → entry」的 Map，方便查詢
const DOMAIN_DICT_NORMALIZED = (() => {
  const map = new Map();
  DOMAIN_ENTRIES.forEach(e => {
    if (e.hanji) {
      const n = normalizeTextForDict(e.hanji);
      if (n) map.set(n, e);
    }
    (e.alias || []).forEach(a => {
      const n = normalizeTextForDict(a);
      if (n) map.set(n, e);
    });
  });
  return map;
})();

// 5. 根據 STT 回來的文字，嘗試用詞庫找「最佳匹配」
//    目前策略：
//    - 先看整句 normalize 後，有沒有完全 match 詞庫 key
//    - 沒有的話，嘗試找「最長子字串」match（適合前後多講幾個字的情境）
function lookupDomainEntry(rawText) {
  const norm = normalizeTextForDict(rawText);
  if (!norm) return null;

  // (1) 整句 match
  if (DOMAIN_DICT_NORMALIZED.has(norm)) {
    return DOMAIN_DICT_NORMALIZED.get(norm);
  }

  // (2) 嘗試最長子字串 match
  let best = null;
  DOMAIN_DICT_NORMALIZED.forEach((entry, keyNorm) => {
    if (!keyNorm) return;
    if (norm.includes(keyNorm)) {
      if (!best || keyNorm.length > best.keyNorm.length) {
        best = { entry, keyNorm };
      }
    }
  });

  return best ? best.entry : null;
}

// 6. 提供一個「照詞庫優先」的漢字決定函式
function chooseHanjiWithDomain(rawText, fallbackHanji) {
  const e = lookupDomainEntry(rawText);
  if (e && e.hanji) {
    return e.hanji;
  }
  return fallbackHanji;
}

    
function stopCurrentAudioStream() {
  if (currentAudioStream) {
    try {
      currentAudioStream.getTracks().forEach(t => t.stop());
    } catch (e) {
      console.warn("stopCurrentAudioStream error:", e);
    }
    currentAudioStream = null;
  }
}
// ⏱ 建立 Google Speech API 的 request body（共用）
// - base64Audio: 當前錄音的 base64 字串
function buildSpeechRequestBody(base64Audio) {
  return {
    config: {
      encoding: "WEBM_OPUS",
      sampleRateHertz: 48000,
      languageCode: "cmn-Hant-TW",
      // B2：針對「說關鍵字」的模式，比較適合 command_and_search
      model: "command_and_search",
      useEnhanced: true, // 若該語言/區域支援，會用增強模型
      speechContexts: [
        {
          phrases: DOMAIN_PHRASES,
          boost: 12.0  // 可以調 5~20，看實測效果
        }
      ]
    },
    audio: { content: base64Audio }
  };
}


// 🔹 使用者自訂台羅→漢字詞庫（存到 localStorage 當作後台）
let userDict = {};

function loadUserDict() {
    try {
        const raw = localStorage.getItem("tailoHanjiUserDict");
        if (raw) {
            userDict = JSON.parse(raw);
        }
    } catch (e) {
        console.error("載入使用者詞庫失敗：", e);
        userDict = {};
    }
}

function saveUserDict() {
    try {
        localStorage.setItem("tailoHanjiUserDict", JSON.stringify(userDict));
    } catch (e) {
        console.error("儲存使用者詞庫失敗：", e);
    }
}

// 主界面、語音辨識元件參考
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const handwriteBtn = document.getElementById("handwriteBtn");
const copyHanjiBtn = document.getElementById("copyHanjiBtn");
const speakHanjiBtn = document.getElementById("speakHanjiBtn");
const tailoOutput = document.getElementById("tailoOutput");
const hanjiOutput = document.getElementById("hanjiOutput");
const statusEl = document.getElementById("status");
const manageBtn = document.getElementById("manageBtn");
const manageMenu = document.getElementById("manageMenu");
const searchBtn = document.getElementById("searchBtn");
const youtubeBtn = document.getElementById("youtubeBtn");
const otherBtn = document.getElementById("otherBtn");
const otherMenu = document.getElementById("otherMenu");
// 輸入元件
const importJsonInput = document.getElementById("importJsonInput");
const importCsvInput = document.getElementById("importCsvInput");
const bgImageInput = document.getElementById("bgImageInput");

// 手寫元件
const handwriteModal = document.getElementById("handwriteModal");
const handCanvas = document.getElementById("handCanvas");
const hwResult = document.getElementById("hwResult");
const hwClearBtn = document.getElementById("hwClearBtn");
const hwRecognizeBtn = document.getElementById("hwRecognizeBtn");
const hwApplyBtn = document.getElementById("hwApplyBtn");
const hwCloseBtn = document.getElementById("hwCloseBtn");

let hwDrawing = false;
let hwCtx = handCanvas.getContext("2d");

let hwStrokes = [];            // [[xs],[ys],[ts]] per stroke (Google Input Tools format)
let hwActiveStroke = null;     // current stroke in InputTools format
let hwLastCandidates = [];     // last candidates list
let hwSelectedText = "";       // currently selected candidate text


/* ====== API 憑證 UI ====== */
const apiKeyBtn = document.getElementById("apiKeyBtn");
const apiKeyModal = document.getElementById("apiKeyModal");
const apiKeyCloseBtn = document.getElementById("apiKeyCloseBtn");
const apiKeyInput = document.getElementById("apiKeyModalInput");
const saveApiKeyBtn = document.getElementById("saveApiKeyBtn");
const clearApiKeyBtn = document.getElementById("clearApiKeyBtn");



// ===== ✏️ 使用說明可編輯（儲存在 localStorage，只需設定一次） =====
const helpContentEl = document.getElementById("helpContent");
const helpFallbackEl = document.getElementById("helpFallback");
const helpIframeWrap = document.getElementById("helpIframeWrap");
const helpIframe = document.getElementById("helpIframe");
const helpIframeStatus = document.getElementById("helpIframeStatus");
const helpReloadIframeBtn = document.getElementById("helpReloadIframeBtn");
const helpUseLocalBtn = document.getElementById("helpUseLocalBtn");
const HELP_IFRAME_URL = 'https://animated-writer-676.notion.site/ebd//2cd7d65a24e780c8b7cefdc183a0e467';

const helpEditBtn = document.getElementById("helpEditBtn");
const helpResetBtn = document.getElementById("helpResetBtn");

const manualEditModal = document.getElementById("manualEditModal");
const manualEditCloseBtn = document.getElementById("manualEditCloseBtn");
const manualEditTextarea = document.getElementById("manualEditTextarea");
const manualEditSaveBtn = document.getElementById("manualEditSaveBtn");
const manualEditCancelBtn = document.getElementById("manualEditCancelBtn");
const manualEditResetBtn = document.getElementById("manualEditResetBtn");

const MANUAL_STORAGE_KEY = "tw_stt_manual_text_v1";
const helpDefaultHTML = helpFallbackEl ? helpFallbackEl.innerHTML : "";
const helpDefaultText = helpFallbackEl ? (helpFallbackEl.innerText || "").trim() : "";





// ===== 📘 使用說明（Help Modal） =====
const helpModal = document.getElementById("helpModal");
const helpCloseBtn = document.getElementById("helpCloseBtn");
function openHelp() {
  helpModal.style.display = "flex";
  renderManual();
  tryLoadHelpIframe();
}
function closeHelp() {
  helpModal.style.display = "none";
}
helpCloseBtn?.addEventListener("click", closeHelp);
helpReloadIframeBtn?.addEventListener("click", () => {
  // 重新嘗試載入線上說明
  tryLoadHelpIframe();
});
helpUseLocalBtn?.addEventListener("click", () => {
  // 手動切換到本機說明
  showHelpFallback("（已切換到本機說明）");
});

helpModal?.addEventListener("click", (e) => {
  if (e.target === helpModal) closeHelp();
});

function getSavedManualText() {
  try { return (localStorage.getItem(MANUAL_STORAGE_KEY) || "").trim(); } catch { return ""; }
}
function saveManualText(text) {
  try { localStorage.setItem(MANUAL_STORAGE_KEY, (text || "").trim()); } catch {}
}
function clearManualText() {
  try { localStorage.removeItem(MANUAL_STORAGE_KEY); } catch {}
}

// 若有自訂說明 → 用純文字顯示（保留換行）；若沒有 → 顯示內建的格式化 HTML
function showHelpIframe() {
  if (helpIframeWrap) helpIframeWrap.style.display = "block";
  if (helpFallbackEl) helpFallbackEl.style.display = "none";
}

function showHelpFallback(msg) {
  if (helpIframeWrap) helpIframeWrap.style.display = "none";
  if (helpFallbackEl) helpFallbackEl.style.display = "block";
  if (helpIframeStatus) helpIframeStatus.textContent = msg || "";
}

function renderManual() {
  if (!helpFallbackEl) return;

  const saved = getSavedManualText();
  if (saved) {
    helpFallbackEl.textContent = saved;
    helpFallbackEl.style.whiteSpace = "pre-wrap";
  } else {
    helpFallbackEl.innerHTML = helpDefaultHTML;
    helpFallbackEl.style.whiteSpace = "normal";
  }
}

// 嘗試載入 Notion iframe；若失敗/逾時則自動切換到本機說明
function tryLoadHelpIframe() {
  // 沒 iframe 就直接用本機
  if (!helpIframe) {
    showHelpFallback("（此瀏覽器不支援 iframe 顯示，已改用本機說明）");
    return;
  }

  // 先顯示 iframe
  showHelpIframe();
  if (helpIframeStatus) helpIframeStatus.textContent = "正在載入線上說明…（若失敗會自動切換到本機說明）";

  let settled = false;
  const timeoutMs = 2500;

  const cleanup = () => {
    helpIframe.onload = null;
    helpIframe.onerror = null;
  };

  helpIframe.onload = () => {
    if (settled) return;
    settled = true;
    cleanup();
    if (helpIframeStatus) helpIframeStatus.textContent = ""; // 成功就清掉狀態
  };

  helpIframe.onerror = () => {
    if (settled) return;
    settled = true;
    cleanup();
    showHelpFallback("（線上說明載入失敗，已切換到本機說明）");
  };

  // 觸發載入（重新指定 src）
  helpIframe.src = HELP_IFRAME_URL;

  // 逾時 fallback（有些情況不會觸發 onerror）
  setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    showHelpFallback("（線上說明載入逾時，已切換到本機說明）");
  }, timeoutMs);
}

function openManualEditor() {
  if (!manualEditModal || !manualEditTextarea) return;
  const saved = getSavedManualText();
  manualEditTextarea.value = saved || helpDefaultText || "";
  manualEditModal.style.display = "flex";
  manualEditTextarea.focus();
}

function closeManualEditor() {
  if (!manualEditModal) return;
  manualEditModal.style.display = "none";
}

helpEditBtn?.addEventListener("click", openManualEditor);
helpResetBtn?.addEventListener("click", () => {
  if (!confirm("要把使用說明重設成預設內容嗎？（你自行編寫的內容會被清除）")) return;
  clearManualText();
  renderManual();
});

manualEditCloseBtn?.addEventListener("click", closeManualEditor);
manualEditCancelBtn?.addEventListener("click", closeManualEditor);
manualEditModal?.addEventListener("click", (e) => {
  if (e.target === manualEditModal) closeManualEditor();
});

manualEditSaveBtn?.addEventListener("click", () => {
  const v = (manualEditTextarea?.value || "").trim();
  if (!v) {
    alert("說明內容不能是空白。若要恢復預設請按『重設為預設』。");
    manualEditTextarea?.focus();
    return;
  }
  saveManualText(v);
  renderManual();
  closeManualEditor();
  alert("已儲存使用說明（下次進來也會保留）。");
});

manualEditResetBtn?.addEventListener("click", () => {
  if (!confirm("確定要重設為預設內容嗎？")) return;
  clearManualText();
  renderManual();
  closeManualEditor();
});


const apiKeyStatus = document.getElementById("apiKeyStatus");


// 開啟/關閉 API 憑證視窗
function openApiKeyModal() {
  if (!apiKeyModal) return;
  apiKeyModal.style.display = "flex";
  if (apiKeyInput) apiKeyInput.value = ""; // 不自動顯示已存 key（安全）
}
function closeApiKeyModal() {
  if (!apiKeyModal) return;
  apiKeyModal.style.display = "none";
}

if (apiKeyBtn) apiKeyBtn.addEventListener("click", openApiKeyModal);
if (apiKeyCloseBtn) apiKeyCloseBtn.addEventListener("click", closeApiKeyModal);

// 點背景關閉
if (apiKeyModal) {
  apiKeyModal.addEventListener("click", (e) => {
    if (e.target === apiKeyModal) closeApiKeyModal();
  });
}

function updateApiKeyUI() {
  if (apiKeyStatus) {
    apiKeyStatus.textContent = (API_KEY && API_KEY.length > 10) ? "（已儲存 ✅）" : "（未設定）";
  }
  if (apiKeyBtn) {
    apiKeyBtn.textContent = (API_KEY && API_KEY.length > 10) ? "🔑 API 憑證 ✅" : "🔑 API 憑證";
  }
}

if (saveApiKeyBtn) {
  saveApiKeyBtn.onclick = () => {
    const v = (apiKeyInput?.value || "").trim();
    if (!v) {
      alert("請先輸入 API Key（或按『清除』移除已儲存的 Key）。");
      apiKeyInput?.focus();
      return;
    }
    setApiKey(v);
    if (apiKeyInput) apiKeyInput.value = "";
    alert("已儲存 API Key。之後不用再輸入。");
  };
}
if (clearApiKeyBtn) {
  clearApiKeyBtn.onclick = () => {
    setApiKey("");
    if (apiKeyInput) apiKeyInput.value = "";
    alert("已清除已儲存的 API Key。");
  };
}

updateApiKeyUI();


function hwNow() { return Date.now(); }

function hwGetPosFromMouse(e){
    const rect = handCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function hwGetPosFromTouch(e){
    const rect = handCanvas.getBoundingClientRect();
    const t = e.touches[0];
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
}

function hwStartStroke(x,y){
    hwActiveStroke = [[x],[y],[0]]; // timestamps relative to stroke start
    hwActiveStroke._t0 = hwNow();
    hwStrokes.push(hwActiveStroke);

    hwCtx.beginPath();
    hwCtx.lineWidth = 10;
    hwCtx.lineCap = "round";
    hwCtx.strokeStyle = "#000";
    hwCtx.moveTo(x,y); // ✅ avoid 0,0 diagonal
}

function hwAddPoint(x,y){
    if (!hwActiveStroke) return;
    const t = hwNow() - hwActiveStroke._t0;
    hwActiveStroke[0].push(Math.round(x));
    hwActiveStroke[1].push(Math.round(y));
    hwActiveStroke[2].push(Math.max(0, Math.round(t)));
    hwCtx.lineTo(x,y);
    hwCtx.stroke();
}

function hwEndStroke(){
    if (hwActiveStroke) delete hwActiveStroke._t0;
    hwActiveStroke = null;
}

function hwRenderCandidates(cands){
    const box = document.getElementById("hwCandList");
    if (!box) return;
    box.innerHTML = "";
    hwLastCandidates = Array.isArray(cands) ? cands.slice(0,5) : [];

    if (!hwLastCandidates.length){
        return;
    }
    hwLastCandidates.forEach((c, idx)=>{
        // c can be string or {text, score}
        const text = (typeof c === "string") ? c : (c.text || "");
        const score = (typeof c === "object" && c && typeof c.score === "number") ? c.score : null;

        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("data-hw-cand", text);
        btn.textContent = score !== null ? `${text}  ${(score*100).toFixed(0)}%` : text;

        btn.onclick = ()=>{
            hwSelectedText = text;
            [...box.querySelectorAll("button")].forEach(b=>b.classList.remove("hw-selected"));
            btn.classList.add("hw-selected");
        };

        // default select first
        if (idx === 0){
            hwSelectedText = text;
            btn.classList.add("hw-selected");
        }
        box.appendChild(btn);
    });
}

// 開始錄音
startBtn.onclick = async () => {
    try {
        audioChunks = [];
        statusEl.innerText = "正在啟動麥克風…";

        // ⭐ 把 stream 存到全域變數
        currentAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        mediaRecorder = new MediaRecorder(currentAudioStream, { mimeType: 'audio/webm;codecs=opus' });

        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

        mediaRecorder.onstop = async () => {
            statusEl.innerText = "正在上傳語音並進行辨識…";
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            const base64Audio = await blobToBase64(blob);

            if (!requireApiKey()) {
                statusEl.innerText = "請先設定 API Key 才能使用語音辨識服務。";
                return;
            }

            try {
                const response = await fetch(
                    `https://speech.googleapis.com/v1/speech:recognize?key=${API_KEY}`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(buildSpeechRequestBody(base64Audio))
                    }
                );

                const data = await response.json();
                console.log("STT response:", data);

                let rawText = data.results?.[0]?.alternatives?.[0]?.transcript || "";
                if (!rawText) {
                  tailoOutput.value = "（無辨識結果，請再試一次）";
                  hanjiOutput.value = "（無辨識結果）";
                  statusEl.innerText = "沒有辨識到語音內容，可能太小聲或太短。";
                } else {
                  tailoOutput.value = rawText;
                
                  const baseHanji = tailoToHanji(rawText);  // 原本的規則轉換
                  hanjiOutput.value = chooseHanjiWithDomain(rawText, baseHanji);
                
                  statusEl.innerText = "辨識完成，可以複製、朗讀或管理常用字。";
                }

                }

             catch (err) {
                console.error(err);
                statusEl.innerText = "語音辨識時發生錯誤，請稍後再試。";
            }

            startBtn.disabled = false;
            stopBtn.disabled = true;
            // ⭐ 把麥克風真的關掉
            stopCurrentAudioStream();
        };

        mediaRecorder.start();
        startBtn.disabled = true;
        stopBtn.disabled = false;
        statusEl.innerText = "正在錄音中，講完後請按「停止錄音」。";

    } catch (err) {
        console.error(err);
        statusEl.innerText = "無法啟動麥克風，請確認瀏覽器權限與麥克風設定。";
    }
};

// 停止錄音
stopBtn.onclick = () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        statusEl.innerText = "已停止錄音，正在處理語音…";
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
};

// 清除內容
clearBtn.onclick = () => {
    tailoOutput.value = "";
    hanjiOutput.value = "";
    statusEl.innerText = "";
    startBtn.disabled = false;
    stopBtn.disabled = true;

    if (typeof mediaRecorder !== "undefined" && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
    }

    if (window.speechSynthesis && window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
    }
    stopCurrentAudioStream();

};

// ✍️ 手寫輸入（下方按鈕）
if (handwriteBtn) {
    handwriteBtn.onclick = () => openHandwrite();
}

//複製文字
async function doCopyHanji() {
  const hanji = hanjiOutput.value.trim();
  if (!hanji) {
    alert("目前沒有可複製的漢字內容！");
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(hanji);
    } else {
      const tempInput = document.createElement("textarea");
      tempInput.value = hanji;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand("copy");
      document.body.removeChild(tempInput);
    }
    alert("已複製漢字到剪貼簿！");
  } catch (e) {
    console.error(e);
    alert("複製失敗，請再試一次。");
  }
}
//朗讀內容
function doSpeakHanji() {
  const hanji = hanjiOutput.value.trim();
  if (!hanji) {
    alert("目前沒有可以朗讀的漢字內容！");
    return;
  }
  if (!("speechSynthesis" in window)) {
    alert("此瀏覽器不支援朗讀功能（SpeechSynthesis）。");
    return;
  }

  const synth = window.speechSynthesis;
  if (synth.speaking) synth.cancel();

  const utterance = new SpeechSynthesisUtterance(hanji);
  utterance.lang = "zh-TW";

  const voices = synth.getVoices();
  const zhVoice =
    voices.find(v => v.lang === "zh-TW") ||
    voices.find(v => v.lang && v.lang.startsWith("zh")) || null;
  if (zhVoice) utterance.voice = zhVoice;

  synth.speak(utterance);
}

// ▼ 管理常用字：下拉選單開關
manageBtn.onclick = (e) => {
    e.stopPropagation();
    manageMenu.classList.toggle("show");
};
otherBtn.onclick = (e) => {
  e.stopPropagation();
  otherMenu.classList.toggle("show");
};

// 點空白處收起
document.addEventListener("click", () => {
  otherMenu.classList.remove("show");
});

// 點畫面其他地方就關閉選單
document.addEventListener("click", () => {
    manageMenu.classList.remove("show");
});

// 處理下拉選單內各項功能
manageMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;
    manageMenu.classList.remove("show");

    if (action === "add") {
        handleAddWord();
    } else if (action === "view") {
        handleViewWords();
    } else if (action === "delete") {
        handleDeleteWord();
    } else if (action === "exportJson") {
        handleExportJSON();
    } else if (action === "importJson") {
        handleImportJSON();
    } else if (action === "exportCsv") {
        handleExportCSV();
    } else if (action === "importCsv") {
        handleImportCSV();
    }
});


// 新增常用字
function handleAddWord() {
    const currentTailo = tailoOutput.value.trim();
    if (!currentTailo || currentTailo.includes("台羅顯示在這裡") || currentTailo.includes("無辨識結果")) {
        alert("目前沒有可以加入詞庫的台羅內容，請先做一次語音辨識。");
        return;
    }

    const tailoKey = prompt("請確認或輸入要加入詞庫的台羅拼音：", currentTailo);
    if (!tailoKey) return;

    const currentHanji =
        hanjiOutput.value.includes("台語漢字顯示在這裡") ||
        hanjiOutput.value.includes("無辨識結果")
            ? ""
            : hanjiOutput.value.trim();

    const hanjiValue = prompt("請輸入對應的漢字（可修改）：", currentHanji);
    if (!hanjiValue) return;

    userDict[tailoKey] = hanjiValue;
    saveUserDict();

    const newHanji = tailoToHanji(currentTailo);
    hanjiOutput.value = newHanji;

    alert("已將此組台羅與漢字加入常用字詞庫。\n\n台羅：" + tailoKey + "\n漢字：" + hanjiValue);
}

// 查看常用字
function handleViewWords() {
    const keys = Object.keys(userDict);
    if (keys.length === 0) {
        alert("目前常用字詞庫是空的。");
        return;
    }

    let msg = "目前常用字列表：\n\n";
    keys.sort((a, b) => a.localeCompare(b));
    keys.forEach((k, i) => {
        msg += (i + 1) + ". " + k + "  →  " + userDict[k] + "\n";
    });

    alert(msg);
}

// 刪除常用字
function handleDeleteWord() {
    const keys = Object.keys(userDict);
    if (keys.length === 0) {
        alert("目前沒有任何常用字可以刪除。");
        return;
    }

    const keyToDelete = prompt("請輸入要刪除的台羅拼音（需與當初新增時的 key 相同）：");
    if (!keyToDelete) return;

    if (!(keyToDelete in userDict)) {
        alert("找不到這個台羅 key 對應的常用字。\n\n你可以先用「查看常用字」看一下列表。");
        return;
    }

    const confirmDelete = confirm(
        "確定要刪除這筆常用字嗎？\n\n台羅：" +
        keyToDelete + "\n漢字：" + userDict[keyToDelete]
    );
    if (!confirmDelete) return;

    delete userDict[keyToDelete];
    saveUserDict();
    alert("已刪除該筆常用字。");
}

// 搜尋漢字：用目前辨識出的漢字到 Google 搜尋
function doGoogleSearch() {
  const qText = hanjiOutput.value.trim();
  if (!qText) { alert("目前沒有可以搜尋的文字內容！"); return; }
  const url = `https://www.google.com/search?q=${encodeURIComponent(qText)}`;
  window.open(url, "_blank");
}
//搜尋Youtube
function doYoutubeSearch() {
  const qText = hanjiOutput.value.trim();
  if (!qText) { alert("目前沒有可以搜尋的文字內容！"); return; }
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(qText)}`;
  window.open(url, "_blank");
}

// ===== ⭐ 我的最愛：資料與渲染 =====
const FAVORITES_KEY = "favoriteFunctionsV1";

// 你目前所有「可被放到最愛 / 其他功能」的功能清單
const ALL_FUNCTIONS = [
  { id: "copyHanji",       label: "📋 複製漢字",       cls: "btn-outline",  run: () => doCopyHanji() },
  { id: "speakHanji",      label: "🔈 朗讀漢字",       cls: "btn-accent",   run: () => doSpeakHanji() },
  { id: "google",          label: "🔍 Google搜尋",    cls: "btn-outline",  run: () => doGoogleSearch() },
  { id: "youtube",         label: "▶ YouTube搜尋",    cls: "btn-youtube",  run: () => doYoutubeSearch() },

  // ✅ 也能加入「我的最愛」的功能
  { id: "addCommonWord",   label: "➕ 新增常用字",     cls: "btn-outline",  run: () => handleAddWord() },
  { id: "setBackground",   label: "🖼 更換背景圖片",   cls: "btn-outline",  run: () => setBackgroundImage() },
  { id: "clearBackground", label: "♻️ 清除背景圖片",   cls: "btn-outline",  run: () => clearBackgroundImage() },
  { id: "handwrite",       label: "✍️ 手寫輸入",       cls: "btn-outline",  run: () => openHandwrite() },
];

// 讀取 / 儲存最愛
function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveFavorites(arr) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(arr));
}

let favorites = loadFavorites();

// DOM 參考（你前面新增的 favoritesBar）
const favoritesBar = document.getElementById("favoritesBar");

// 讓「其他功能」選單由程式動態生成（未加入最愛的才放進去）
// ⭐ 最多顯示幾個「我的最愛」
const MAX_FAVORITES_VISIBLE = 4; // ✅ 你想顯示幾個就改這裡（例如 4）

function renderOtherMenu() {
    otherMenu.innerHTML = "";

    // ⭐ 管理我的最愛
    const manageBtn = document.createElement("button");
    manageBtn.type = "button";
    manageBtn.dataset.action = "manageFavorites";
    manageBtn.textContent = "⭐ 管理我的最愛";
    otherMenu.appendChild(manageBtn);

    // ↕ 重新排序我的最愛（你問的那一段就在這裡）
    const reorderBtn = document.createElement("button");
    reorderBtn.type = "button";
    reorderBtn.dataset.action = "reorderFavorites";
    reorderBtn.textContent = "↕ 重新排序我的最愛";
    otherMenu.appendChild(reorderBtn);

    // 📘 使用說明
    const helpBtn = document.createElement("button");
    helpBtn.type = "button";
    helpBtn.dataset.action = "help";
    helpBtn.textContent = "📘 使用說明";
    otherMenu.appendChild(helpBtn);
    
    // 👪 家庭設定（放在「使用說明」附近）
    const familyBtn = document.createElement("button");
    familyBtn.type = "button";
    familyBtn.dataset.action = "familySettings";
    familyBtn.textContent = "👪 家庭設定";
    otherMenu.appendChild(familyBtn);

    // 分隔線
    const sep = document.createElement("div");
    sep.style.height = "1px";
    sep.style.background = "#e5e7eb";
    sep.style.margin = "6px 0";
    otherMenu.appendChild(sep);

    // 下面才是「沒有設為最愛」的一般功能
    const favSet = new Set(favorites);
    const nonFav = ALL_FUNCTIONS.filter(f => !favSet.has(f.id));

    nonFav.forEach(f => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.action = "run:" + f.id;
        b.textContent = f.label;
        otherMenu.appendChild(b);
    });
}



// 渲染「我的最愛」按鈕列
function renderFavoritesBar() {
  favoritesBar.innerHTML = "";
  const map = new Map(ALL_FUNCTIONS.map(f => [f.id, f]));
  const validFavs = favorites.filter(id => map.has(id));

  // 若最愛是空的，顯示提示（可選）
  if (validFavs.length === 0) {
    const hint = document.createElement("div");
    hint.style.color = "#6b7280";
    hint.style.fontSize = "14px";
    hint.textContent = "（尚未設定最愛，可到「其他功能 → 管理我的最愛」設定）";
    favoritesBar.appendChild(hint);
    return;
  }

  validFavs.forEach(id => {
    const f = map.get(id);
    const btn = document.createElement("button");
    btn.className = f.cls || "btn-outline";
    btn.textContent = f.label;
    btn.onclick = f.run;

    // 右上角小叉叉：移出最愛（長輩也好用）
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      const ok = confirm(`要把「${f.label}」移出我的最愛嗎？`);
      if (ok) {
        favorites = favorites.filter(x => x !== id);
        saveFavorites(favorites);
        renderFavoritesBar();
        renderOtherMenu();
      }
    };

    favoritesBar.appendChild(btn);
  });
}

// 管理最愛：用簡單輸入方式（不用做複雜 UI）
function manageFavoritesPrompt() {
  const lines = ALL_FUNCTIONS.map((f, i) => {
    const mark = favorites.includes(f.id) ? "★" : "☆";
    return `${i + 1}. ${mark} ${f.label}`;
  }).join("\n");

  const input = prompt(
`請輸入要「設為我的最愛」的功能編號（可多個，用逗號分隔）
例如：1,3,4

目前功能清單：
${lines}`, 
    ""
  );

  if (input === null) return; // 取消

  const nums = input.split(",").map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n));
  const picked = [];
  nums.forEach(n => {
    const f = ALL_FUNCTIONS[n - 1];
    if (f) picked.push(f.id);
  });

  // 去重、保留順序
  favorites = [...new Set(picked)];
  saveFavorites(favorites);
  renderFavoritesBar();
  renderOtherMenu();
  alert("已更新「我的最愛」。\n\n提示：在最愛按鈕上按右鍵可移出最愛。");
}
function reorderFavoritesPrompt() {
  const map = new Map(ALL_FUNCTIONS.map(f => [f.id, f]));
  const validFavs = favorites.filter(id => map.has(id));

  if (validFavs.length <= 1) {
    alert("我的最愛少於 2 個，不需要重新排序。");
    return;
  }

  const list = validFavs.map((id, i) => {
    const f = map.get(id);
    return `${i + 1}. ${f.label}`;
  }).join("\n");

  const input = prompt(
    `請輸入新的順序（用逗號分隔）：
    例如想把第 3 個放到最前面：3,1,2

    目前順序：
    ${list}`, 
    validFavs.map((_, i) => i + 1).join(",")
  );

  if (input === null) return;

  const nums = input
    .split(",")
    .map(x => parseInt(x.trim(), 10))
    .filter(n => !isNaN(n));

  // 必須剛好等於最愛數量，且不重複，且都在範圍內
  const n = validFavs.length;
  const set = new Set(nums);

  if (nums.length !== n || set.size !== n || nums.some(x => x < 1 || x > n)) {
    alert("輸入格式不正確。\n請輸入 1 到 " + n + " 的不重複編號，且數量要剛好 " + n + " 個。");
    return;
  }

  // 依新順序重排 favorites
  favorites = nums.map(idx => validFavs[idx - 1]);
  saveFavorites(favorites);

  renderFavoritesBar();
  renderOtherMenu();

  alert("已更新我的最愛順序。");
}

// 其他功能選單：執行功能 / 管理最愛
otherMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const action = btn.dataset.action;
    if (action === 'help') {
      openHelp();
      closeDropdowns();
      return;
    }
  otherMenu.classList.remove("show");

  if (action === "manageFavorites") {
    manageFavoritesPrompt();
    return;
  }
  if (action === "reorderFavorites") {
    reorderFavoritesPrompt();
    return;
  }
  if (action === "setBackground") {
    setBackgroundImage();
    return;
  }
  if (action === "clearBackground") {
    clearBackgroundImage();
    return;
  }
  if (action === "handwrite") {
    openHandwrite();
    return;
    }
    if (action === "familySettings") {
  openFamilySettings();
  closeDropdowns?.();
  return;
}

  
  if (action && action.startsWith("run:")) {
    const id = action.slice(4);
    const f = ALL_FUNCTIONS.find(x => x.id === id);
    if (f) f.run();
    return;
  }
});

let currentBgObjectUrl = null;

// 開啟 IndexedDB
function openAppDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("TailoToolDB", 1);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 寫入背景（Blob）
async function idbSetBackground(blob) {
  const db = await openAppDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    store.put({ key: "background", blob, updatedAt: Date.now() });

    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// 讀取背景（Blob）
async function idbGetBackground() {
  const db = await openAppDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const store = tx.objectStore("settings");
    const req = store.get("background");

    req.onsuccess = () => {
      const row = req.result;
      db.close();
      resolve(row ? row.blob : null);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// 刪除背景
async function idbDeleteBackground() {
  const db = await openAppDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    store.delete("background");

    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// 套用背景（用 ObjectURL 顯示 Blob）
function applyBackgroundFromBlob(blob) {
  // 清掉舊的 objectURL，避免記憶體累積
  if (currentBgObjectUrl) {
    URL.revokeObjectURL(currentBgObjectUrl);
    currentBgObjectUrl = null;
  }

  if (blob) {
    currentBgObjectUrl = URL.createObjectURL(blob);
    document.body.style.backgroundImage = `url(${currentBgObjectUrl})`;
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
    document.body.style.backgroundRepeat = "no-repeat";
  } else {
    document.body.style.backgroundImage = "";
    document.body.style.background = "#f3f4f6";
  }
}

// 點選：添加背景圖片
function setBackgroundImage() {
  bgImageInput.value = "";
  bgImageInput.click();
}

// 讀檔後存到 IndexedDB
bgImageInput.addEventListener("change", async () => {
  const file = bgImageInput.files[0];
  if (!file) return;

  // 可選：限制檔案大小，避免超大圖造成效能問題（這不是 localStorage 限制，而是使用體驗）
  const MAX_SIZE = 5 * 1024 * 1024; // 5MB（你可調大/調小）
  if (file.size > MAX_SIZE) {
    alert("圖片檔案太大，建議選擇小於 5MB 的圖片。");
    return;
  }

  try {
    await idbSetBackground(file);     // 直接存 Blob（File 也是 Blob）
    applyBackgroundFromBlob(file);    // 立即套用
    alert("已設定背景圖片（已存入 IndexedDB）。");
  } catch (e) {
    console.error(e);
    alert("儲存背景失敗，請再試一次。");
  }
});

// 清除背景
async function clearBackgroundImage() {
  try {
    await idbDeleteBackground();
    applyBackgroundFromBlob(null);
    alert("已清除背景圖片。");
  } catch (e) {
    console.error(e);
    alert("清除背景失敗，請再試一次。");
  }
}

// 啟動時：從 IndexedDB 載入背景
(async function initBackgroundFromIDB() {
  try {
    const blob = await idbGetBackground();
    if (blob) applyBackgroundFromBlob(blob);
  } catch (e) {
    console.error(e);
  }
})();

// 匯出 JSON
function handleExportJSON() {
    const keys = Object.keys(userDict);
    if (keys.length === 0) {
        alert("目前常用字詞庫是空的，沒有可匯出的資料。");
        return;
    }

    const blob = new Blob([JSON.stringify(userDict, null, 2)], {
        type: "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tailo_hanji_dict.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// 匯入 JSON
function handleImportJSON() {
    importJsonInput.value = ""; // 重設，避免同檔案兩次無法觸發
    importJsonInput.click();
}

importJsonInput.addEventListener("change", () => {
    const file = importJsonInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const obj = JSON.parse(reader.result);
            if (typeof obj !== "object" || obj === null) {
                alert("JSON 格式不正確（應該是一個物件）。");
                return;
            }

            let count = 0;
            for (const key in obj) {
                if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
                userDict[key] = obj[key];
                count++;
            }
            saveUserDict();
            alert("已從 JSON 匯入 " + count + " 筆常用字。");

        } catch (e) {
            console.error(e);
            alert("匯入 JSON 時發生錯誤，請確認檔案格式是否正確。");
        }
    };
    reader.readAsText(file, "utf-8");
});

// 匯出 CSV（格式：tailo,hanji）
function handleExportCSV() {
    const keys = Object.keys(userDict);
    if (keys.length === 0) {
        alert("目前常用字詞庫是空的，沒有可匯出的資料。");
        return;
    }

    // 簡單 CSV：第一列標題，後面每列：台羅,漢字
    let lines = ["tailo,hanji"];
    keys.forEach((k) => {
        const v = userDict[k];
        const safeK = String(k).replace(/"/g, '""');
        const safeV = String(v).replace(/"/g, '""');
        lines.push(`"${safeK}","${safeV}"`);
    });

    const csv = lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tailo_hanji_dict.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// 匯入 CSV（假設格式為：tailo,hanji，第一列可為標題）
function handleImportCSV() {
    importCsvInput.value = "";
    importCsvInput.click();
}

importCsvInput.addEventListener("change", () => {
    const file = importCsvInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const text = reader.result;
            const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
            if (lines.length === 0) {
                alert("CSV 檔案內容是空的。");
                return;
            }

            let startIndex = 0;
            // 若第一列看起來像標題，就略過
            if (/tailo/i.test(lines[0]) && /hanji/i.test(lines[0])) {
                startIndex = 1;
            }

            let count = 0;
            for (let i = startIndex; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) continue;

                // 簡單解析："a","b" 或 a,b
                let parts;
                if (line.includes('","')) {
                    // 假設格式："台羅","漢字"
                    const m = line.match(/^"(.*)","(.*)"$/);
                    if (m) {
                        parts = [m[1], m[2]];
                    } else {
                        parts = line.split(",");
                    }
                } else {
                    parts = line.split(",");
                }

                if (parts.length < 2) continue;

                const tailo = parts[0].replace(/^"|"$/g, "").trim();
                const hanji = parts[1].replace(/^"|"$/g, "").trim();
                if (!tailo) continue;

                userDict[tailo] = hanji;
                count++;
            }

            saveUserDict();
            alert("已從 CSV 匯入 " + count + " 筆常用字。");

        } catch (e) {
            console.error(e);
            alert("匯入 CSV 時發生錯誤，請確認檔案格式是否正確。");
        }
    };
    reader.readAsText(file, "utf-8");
});

// 台羅 → 漢字（先套用使用者詞庫，再套用內建規則）
function tailoToHanji(t) {
    let s = t;

    // ① 先套用「使用者自訂的常用字詞庫」
    const keys = Object.keys(userDict).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        if (!key) continue;
        s = s.split(key).join(userDict[key]);
    }

    // ② 再套用內建規則（範例，可依需求擴充）
    s = s.replace(/Lí chia̍h pá bē/gi, "你食飽未");
    s = s.replace(/Lí beh khì Tâi-pak/gi, "你欲去台北");
    s = s.replace(/Lí hó/gi, "你好");
    s = s.replace(/tsài-ji̍t/gi, "昨日");
    s = s.replace(/tsin hó/gi, "很好");
    s = s.replace(/tsit ê/gi, "一個");
    s = s.replace(/tsia̍h-pn̄g/gi, "食飯");

    s = s.replace(/Lí/gi, "你");
    s = s.replace(/Góa/gi, "我");
    s = s.replace(/iáu-sī/gi, "猶是");
    s = s.replace(/beh/gi, "欲");
    s = s.replace(/bē/gi, "未");
    s = s.replace(/bô/gi, "無");
    s = s.replace(/khì/gi, "去");
    s = s.replace(/lâi/gi, "來");
    s = s.replace(/tsia̍h/gi, "食");
    s = s.replace(/pn̄g/gi, "飯");
    s = s.replace(/pá/gi, "飽");
    s = s.replace(/hó/gi, "好");
    s = s.replace(/tio̍h/gi, "著");
    s = s.replace(/kuì/gi, "過");
    s = s.replace(/sió/gi, "小");
    s = s.replace(/lāu-lâng/gi, "老人");
    s = s.replace(/lāu-lōo/gi, "老爺");
    s = s.replace(/lāu-bú/gi, "老母");
    s = s.replace(/tshù/gi, "家");
    s = s.replace(/tī/gi, "佇");
    s = s.replace(/hāi/gi, "海");
    s = s.replace(/Tâi-pak/gi, "台北");
    s = s.replace(/Tâi-uân/gi, "台灣");

    return s;
}
// ====== 手寫畫布基本操作 ====== 開始搬移
handCanvas.addEventListener("mousedown", (e) => {
    hwDrawing = true;
    const {x,y} = hwGetPosFromMouse(e);
    hwStartStroke(x,y);
});
handCanvas.addEventListener("mousemove", (e) => {
    if (!hwDrawing) return;
    const {x,y} = hwGetPosFromMouse(e);
    hwAddPoint(x,y);
});
handCanvas.addEventListener("mouseup", () => { hwDrawing = false; hwEndStroke(); });
handCanvas.addEventListener("mouseout", () => { hwDrawing = false; hwEndStroke(); });

// 手機版觸控
handCanvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    hwDrawing = true;
    const {x,y} = hwGetPosFromTouch(e);
    hwStartStroke(x,y);
});
handCanvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (!hwDrawing) return;
    const {x,y} = hwGetPosFromTouch(e);
    hwAddPoint(x,y);
});
handCanvas.addEventListener("touchend", () => { hwDrawing = false; hwEndStroke(); });


// ====== 清除畫布 ======// ====== 清除畫布 ======
hwClearBtn.onclick = () => {
    hwCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
    hwStrokes = [];
    hwActiveStroke = null;
    hwLastCandidates = [];
    hwSelectedText = "";
    hwResult.innerText = "（尚無辨識結果）";
    const box = document.getElementById("hwCandList");
    if (box) box.innerHTML = "";

};


// ====== 辨識手寫文字 ======
// 優先用 Google Input Tools 手寫（可回傳多候選）
// 失敗再 fallback 到 Google Cloud Vision（通常只回一個文字結果）
hwRecognizeBtn.onclick = async () => {
    hwResult.innerText = "辨識中…";
    hwRenderCandidates([]);

    // 1) Google Input Tools handwriting (unofficial but very practical)
    // 需要 ink（筆畫座標），所以我們用 hwStrokes
    try {
        if (hwStrokes.length === 0) {
            hwResult.innerText = "（請先寫字再辨識）";
            return;
        }

        const payload = {
            options: "enable_pre_space",
            requests: [{
                writing_guide: { width: handCanvas.width, height: handCanvas.height },
                ink: hwStrokes,
                language: "zh-Hant"
            }]
        };

        const r = await fetch("https://inputtools.google.com/request?itc=zh-hant-t-i0-handwrit&app=translate", {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(payload)
        });

        const j = await r.json();
        // 格式通常是 ["SUCCESS",[["候選1","候選2",...],...]]
        if (Array.isArray(j) && j[0] === "SUCCESS") {
            const cands = (j?.[1]?.[0]?.[1]) || [];
            const top5 = cands.slice(0, 5).map((t, idx) => ({ text: t, score: [1,0.85,0.7,0.6,0.5][idx] }));
            if (!top5.length) {
                hwResult.innerText = "（沒有辨識到清楚的漢字，請再試一次）";
                return;
            }
            hwResult.innerText = "請點選候選字（前 5）：";
            hwRenderCandidates(top5);
            return;
        }
        // 若不是 SUCCESS，丟去 fallback
        console.warn("InputTools not SUCCESS:", j);
    } catch (e) {
        console.warn("InputTools handwriting failed, fallback to Vision:", e);
    }

    // 2) Fallback: Google Cloud Vision OCR（需要你的 API_KEY 啟用且可用）
    try {
        const dataUrl = handCanvas.toDataURL("image/png");
        const base64Image = dataUrl.split(",")[1];

        const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                requests: [{
                    image: { content: base64Image },
                    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                    imageContext: { languageHints: ["zh-Hant"] }
                }]
            })
        });

        const data = await response.json();
        console.log("Vision response:", data);

        const text = data.responses?.[0]?.fullTextAnnotation?.text?.trim() || "";
        if (!text) {
            hwResult.innerText = "（沒有辨識到清楚的漢字，請再試一次）";
            return;
        }

        // Vision 多半只回一段文字：把第一個字當作候選 1
        const firstChar = text.replace(/\s+/g, "")[0] || text;
        hwResult.innerText = "候選字（Vision fallback）：";
        hwRenderCandidates([{ text: firstChar, score: 1 }]);

    } catch (e) {
        console.error(e);
        hwResult.innerText = "辨識時發生錯誤（可能是網路或 API_KEY/權限問題）。";
    }
};



// ====== 手動套用辨識結果（不自動輸入） ======
hwApplyBtn.onclick = () => {
    // 優先使用「使用者點選的候選字」
    let text = (hwSelectedText || "").trim();

    // 若沒有點選（或舊引擎只回傳純文字），就嘗試從畫面抓第一個候選或舊格式
    if (!text) {
        // 嘗試從候選清單的第一個按鈕抓
        const firstBtn = document.querySelector("#hwCandList button[data-hw-cand]");
        if (firstBtn) text = (firstBtn.getAttribute("data-hw-cand") || "").trim();
    }
 
   // 最後 fallback：舊版顯示「辨識結果：xxx」
    if (!text) {
        const raw = (hwResult.innerText || "").trim();
        if (!raw || raw === "（尚無辨識結果）" || raw.includes("沒有辨識到") || raw.includes("辨識中")) {
            alert("尚未有可套用的辨識結果！");
            return;
        }
        text = raw.replace(/^辨識結果：\s*/,"").trim();
    }

    if (!text) {
        alert("辨識內容為空，請再試一次。");
        return;
    }

    // 👉 手動加到漢字輸入匡（不會覆蓋，改成接在後面，不自動換行）
    // 避免辨識結果帶入換行或空白
    text = text.replace(/[]/g, "").trim();

    hanjiOutput.value += text;

    alert("已將文字加入漢字輸入框。");
};


// ====== 開關彈窗 ======
function openHandwrite() {
    handwriteModal.style.display = "flex";
    hwCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
    hwStrokes = [];
    hwActiveStroke = null;
    hwLastCandidates = [];
    hwSelectedText = "";
    hwResult.innerText = "（尚無辨識結果）";
    const box = document.getElementById("hwCandList");
    if (box) box.innerHTML = "";
};
hwCloseBtn.onclick = () => {
    handwriteModal.style.display = "none";
};

// 初始化：載入常用字詞庫
loadUserDict();
renderFavoritesBar();
renderOtherMenu();
 /* =========================
   🧓 極簡模式：按鈕接線
   ========================= */

// 1) 取得DOM
const simpleModeEl = document.getElementById("simpleMode");
const advancedEl = document.querySelector(".container"); // 你原本的主UI容器

const simpleTalkBtn = document.getElementById("simpleTalkBtn");
const simpleYoutubeBtn = document.getElementById("simpleYoutubeBtn");
const simpleClearBtn = document.getElementById("simpleClearBtn");
const simpleStatusEl = document.getElementById("simpleStatus");
const simpleResultTextEl = document.getElementById("simpleResultText");
const goAdvancedLink = document.getElementById("goAdvancedLink");

// 2) 若你原本沒有 blobToBase64，補一個
if (typeof blobToBase64 !== "function") {
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result || "";
        const base64 = String(dataUrl).split(",")[1] || "";
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

// 3) 極簡模式狀態
let simpleIsRecording = false;
let simpleLastQuery = "";

// 4) 顯示/隱藏模式
function showSimpleMode() {
  if (simpleModeEl) simpleModeEl.style.display = "block";
  if (advancedEl) advancedEl.style.display = "none";
  if (simpleStatusEl) simpleStatusEl.textContent = "請按紅色按鈕講話";
}

function showAdvancedMode() {
  if (simpleModeEl) simpleModeEl.style.display = "none";
  if (advancedEl) advancedEl.style.display = "block";
}
/* =========================
   2.5：雙向切換入口 + 長按標題 3 秒切換
   ========================= */

// 進階 → 極簡：底部小連結
const goSimpleLink = document.getElementById("goSimpleLink");
if (goSimpleLink) {
  const toSimple = () => showSimpleMode();
  goSimpleLink.addEventListener("click", toSimple);
  goSimpleLink.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toSimple();
  });
}

// 極簡 → 進階：你已經有 goAdvancedLink，我這裡確保它一定能用
if (typeof bindAdvancedSwitch === "function") {
  // 你第2個已呼叫過也沒關係，重複綁定風險低；若你想避免重複，可移除此段
  bindAdvancedSwitch();
} else {
  // 若你不小心刪到第2個的 bindAdvancedSwitch，這裡做保底
  const goAdvancedLink2 = document.getElementById("goAdvancedLink");
  if (goAdvancedLink2) {
    const toAdvanced = () => showAdvancedMode();
    goAdvancedLink2.addEventListener("click", toAdvanced);
    goAdvancedLink2.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") toAdvanced();
    });
  }
}

/* ---- 長按標題 3 秒切換（避免誤觸） ----
   - 長按「進階模式標題」→ 進入極簡
   - 長按「極簡模式標題」→ 回到進階
*/
function enableLongPressToggleTitle(titleEl, targetMode /* "simple" | "advanced" */) {
  if (!titleEl) return;

  let timer = null;
  const HOLD_MS = 3000;

  const startHold = (e) => {
    // 避免手機長按出現選取/選單干擾
    try { e.preventDefault(); } catch {}
    clearTimeout(timer);

    timer = setTimeout(() => {
      timer = null;
      if (targetMode === "simple") {
        showSimpleMode();
        // 給一個明確提示，避免長輩不知道發生什麼
        try { simpleSetStatus("已切換到極簡模式"); } catch {}
      } else {
        showAdvancedMode();
      }
      // 小震動（有支援才震）
      try { if (navigator.vibrate) navigator.vibrate(30); } catch {}
    }, HOLD_MS);
  };

  const cancelHold = () => {
    clearTimeout(timer);
    timer = null;
  };

  // 滑鼠
  titleEl.addEventListener("mousedown", startHold);
  titleEl.addEventListener("mouseup", cancelHold);
  titleEl.addEventListener("mouseleave", cancelHold);

  // 觸控
  titleEl.addEventListener("touchstart", startHold, { passive: false });
  titleEl.addEventListener("touchend", cancelHold);
  titleEl.addEventListener("touchcancel", cancelHold);
}
const toggleBtn = document.getElementById("toggleExtraFeaturesBtn");

// 你要隱藏的區塊（依你目前頁面結構）
const extraFeatureBlocks = [
  document.getElementById("otherBtn") ||
    document.getElementById("otherMenu"),
  document.getElementById("apiKeyBtn"),
  document.getElementById("manageBtn")
].filter(Boolean);

const STORAGE_KEY = "hideExtraFeatures";

function applyExtraFeatureState(hidden) {
  extraFeatureBlocks.forEach(el => {
    el.style.display = hidden ? "none" : "";
  });
  toggleBtn.textContent = hidden ? " 隱藏狀態" : " 顯示狀態";
}

let hidden = localStorage.getItem(STORAGE_KEY) === "1";
applyExtraFeatureState(hidden);

toggleBtn.addEventListener("click", () => {
  hidden = !hidden;
  localStorage.setItem(STORAGE_KEY, hidden ? "1" : "0");
  applyExtraFeatureState(hidden);
});

// 進階模式標題（你原本 .container 裡的 h1）
const advancedTitle = document.querySelector(".container h1");
enableLongPressToggleTitle(advancedTitle, "simple");

// 極簡模式標題（simpleMode 裡的 h1）
const simpleTitle = document.querySelector("#simpleMode .simple-title");
enableLongPressToggleTitle(simpleTitle, "advanced");

// 5) 你可以在這裡決定「預設進入哪個模式」
//    目前先：維持你原本進階模式顯示（不強制切換）
 showSimpleMode(); // ← 如果你想預設給長輩用，就取消註解這行

// 6) 讓「切換進階模式」可用
function bindAdvancedSwitch() {
  if (!goAdvancedLink) return;
  const fn = () => showAdvancedMode();
  goAdvancedLink.addEventListener("click", fn);
  goAdvancedLink.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fn();
  });
}
bindAdvancedSwitch();

// 7) 極簡模式：更新畫面
function simpleSetStatus(msg) {
  if (simpleStatusEl) simpleStatusEl.textContent = msg;
}
function simpleSetResult(text) {
  if (simpleResultTextEl) simpleResultTextEl.textContent = text || "（尚未輸入）";
}

// 8) 極簡模式：開 YouTube（加上「卡拉OK」更符合使用習慣）
function openYouTubeForKaraoke(query) {
  const q = (query || "").trim();
  if (!q) return;
  //const karaokeQ = `${q} 卡拉OK`; -------> 需要在加卡啦ＯＫ
  const karaokeQ = `${q}`
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(karaokeQ)}`;
  window.open(url, "_blank");
}

// 9) 極簡模式：開始錄音（按一下）
async function simpleStartRecording() {
  try {
    audioChunks = []; // 你原本就有 audioChunks
    simpleSetStatus("我在聽，你慢慢講");
    simpleTalkBtn.textContent = "🟥 再按一次結束";
    simpleIsRecording = true;

    currentAudiostream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
          }
        });
    mediaRecorder = new MediaRecorder(currentAudioStream);

    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);

    mediaRecorder.onstop = async () => {
      // 停止後要做辨識
    stopCurrentAudioStream();

      simpleSetStatus("我聽好了，幫你處理中…");

      // ⭐ 如果沒有 API Key：不要彈 alert 轟炸長輩，用大字提示
      if (!requireApiKey()) {
        simpleSetStatus("需要先設定一次（請家人幫忙）→ 點下面『切換進階模式』");
        simpleTalkBtn.textContent = "🔴 按這裡講話";
        simpleIsRecording = false;
        return;
      }

      try {
        const blob = new Blob(audioChunks, { type: "audio/webm" });
        const base64Audio = await blobToBase64(blob);

        const response = await fetch(
          `https://speech.googleapis.com/v1/speech:recognize?key=${API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildSpeechRequestBody(base64Audio))
          }
        );

        const data = await response.json();
        const rawText = data.results?.[0]?.alternatives?.[0]?.transcript || "";

        if (!rawText) {
          simpleLastQuery = "";
          simpleSetResult("（剛剛沒聽清楚）");
          simpleSetStatus("剛剛沒聽清楚，再講一次沒關係");
        } else {
          simpleLastQuery = rawText;
        
          try { tailoOutput.value = rawText; } catch {}
          try {
            const baseHanji = tailoToHanji(rawText);
            hanjiOutput.value = chooseHanjiWithDomain(rawText, baseHanji);
          } catch {}
        
          const showText = (hanjiOutput?.value || rawText).trim();
          simpleSetResult(`「${showText}」`);
          simpleSetStatus("我聽好了！要不要幫你去 YouTube 找？");
        }

      } catch (err) {
        console.error(err);
        simpleSetStatus("網路或服務有問題，請再試一次");
      } finally {
        simpleTalkBtn.textContent = "🔴 按這裡講話";
        simpleIsRecording = false;
      }
        stopCurrentAudioStream();
    };

    mediaRecorder.start();
  } catch (err) {
    console.error(err);
    simpleSetStatus("無法開啟麥克風（請檢查權限）");
    simpleTalkBtn.textContent = "🔴 按這裡講話";
    simpleIsRecording = false;
  }
}

// 10) 極簡模式：停止錄音（再按一次）
function simpleStopRecording() {
  try {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      simpleSetStatus("我聽好了，幫你處理中…");
    }
  } catch (e) {
    console.error(e);
  }
}

// 11) 極簡模式：按鈕事件
if (simpleTalkBtn) {
  simpleTalkBtn.addEventListener("click", async () => {
    if (!simpleIsRecording) await simpleStartRecording();
    else simpleStopRecording();
  });
}

if (simpleYoutubeBtn) {
  simpleYoutubeBtn.addEventListener("click", () => {
    // 優先用「漢字輸入框」內容（你已經可手動輸入），其次用辨識結果
    const q = (hanjiOutput?.value || "").trim() || (simpleLastQuery || "").trim();
    if (!q) {
      simpleSetStatus("請先按紅色按鈕講話");
      return;
    }
    simpleSetStatus("幫你找歌中…");
    openYouTubeForKaraoke(q);
  });
}

if (simpleClearBtn) {
  simpleClearBtn.addEventListener("click", () => {
    // 若正在錄音，先停掉，避免狀態亂掉
    try {
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    } catch {}

    simpleIsRecording = false;
    simpleLastQuery = "";
    simpleTalkBtn.textContent = "🔴 按這裡講話";
    simpleSetResult("（尚未輸入）");
    simpleSetStatus("好了，可以再講一次");
    stopCurrentAudioStream();


    // 同步清空進階模式輸入框
    try { tailoOutput.value = ""; } catch {}
    try { hanjiOutput.value = ""; } catch {}
  });
}
    /* =========================
   ✅ 預設啟動策略（記住模式）
   ========================= */

const MODE_KEY = "tw_tailo_mode_v1"; // "simple" | "advanced"
const FORCE_SIMPLE_KEY = "tw_tailo_force_simple_v1"; // "1" 表示永遠極簡（可選）

function getSavedMode() {
  try { return (localStorage.getItem(MODE_KEY) || "").trim(); } catch { return ""; }
}
function setSavedMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
}
function getForceSimple() {
  try { return (localStorage.getItem(FORCE_SIMPLE_KEY) || "").trim() === "1"; } catch { return false; }
}
// 你想要「發給長輩就永遠極簡」時可呼叫：localStorage.setItem(FORCE_SIMPLE_KEY,"1");

function openModeGate() {
  const gate = document.getElementById("modeGate");
  if (gate) gate.style.display = "flex";
}
function closeModeGate() {
  const gate = document.getElementById("modeGate");
  if (gate) gate.style.display = "none";
}

function initLaunchMode() {
  // 0) 若你想強制永遠極簡（例如發給長輩），就直接走這裡
  if (getForceSimple()) {
    showSimpleMode();
    return;
  }

  // 1) 若有記錄，就照記錄進入
  const saved = getSavedMode();
  if (saved === "simple") {
    showSimpleMode();
    return;
  }
  if (saved === "advanced") {
    showAdvancedMode();
    return;
  }
  // 1.5) 若沒記住模式，改看「預設策略」
  const strategy = (lsGet(DEFAULT_STRATEGY_KEY) || "ask");
  if (strategy === "simple") { showSimpleMode(); return; }
  if (strategy === "advanced") { showAdvancedMode(); return; }
  // strategy === "ask" → 照原本流程 openModeGate()


  // 2) 第一次進站：跳出選擇模式
  openModeGate();

  const btnSimple = document.getElementById("chooseSimpleBtn");
  const btnAdvanced = document.getElementById("chooseAdvancedBtn");
  const rememberChk = document.getElementById("rememberModeChk");

  const remember = () => !!(rememberChk && rememberChk.checked);

  if (btnSimple) {
    btnSimple.onclick = () => {
      if (remember()) setSavedMode("simple");
      closeModeGate();
      showSimpleMode();
      try { simpleSetStatus("已切換到極簡模式"); } catch {}
    };
  }

  if (btnAdvanced) {
    btnAdvanced.onclick = () => {
      if (remember()) setSavedMode("advanced");
      closeModeGate();
      showAdvancedMode();
    };
  }

  // 點背景不關（避免長輩誤關）
  const gate = document.getElementById("modeGate");
  if (gate) {
    gate.addEventListener("click", (e) => {
      // 如果你想允許點背景關閉，就把下面 return 拿掉，改成 closeModeGate()
      if (e.target === gate) {
        // 不做事，避免誤關造成「我剛剛按到不見了」的困擾
        return;
      }
    });
  }
}
/* =========================
   👪 家庭設定：入口 + 邏輯
   ========================= */
//const/constconstㄥconst MO = KEY = "tw_tailo_mo;                       // "sim
//nced" const FORCE_SIMP = KEY = "tw_tailo_force_simp; _v1"; // "1" 
const DEFAULT_STRATEGY_KEY = "tw_tailo_default_strategy_v1"; // "ask" | "simple" | "advanced"

function lsGet(k){ try { return (localStorage.getItem(k) || "").trim(); } catch { return ""; } }
function lsSet(k,v){ try { localStorage.setItem(k, v); } catch {} }
function lsDel(k){ try { localStorage.removeItem(k); } catch {} }

const familyModal = document.getElementById("familyModal");
const familyCloseBtn = document.getElementById("familyCloseBtn");
const familyStatus = document.getElementById("familyStatus");

const forceSimpleChk = document.getElementById("forceSimpleChk");
const btnGoSimpleNow = document.getElementById("btnGoSimpleNow");
const btnGoAdvancedNow = document.getElementById("btnGoAdvancedNow");
const btnResetModeRemember = document.getElementById("btnResetModeRemember");
const btnClearForceSimple = document.getElementById("btnClearForceSimple");

function familySetStatus(msg){
  if (familyStatus) familyStatus.textContent = msg || "";
}

function openFamilySettings(){
  if (!familyModal) return;

  // 同步 UI
  const forced = lsGet(FORCE_SIMPLE_KEY) === "1";
  if (forceSimpleChk) forceSimpleChk.checked = forced;

  const strat = lsGet(DEFAULT_STRATEGY_KEY) || "ask";
  const radios = document.querySelectorAll('input[name="defaultModeRadio"]');
  radios.forEach(r => { r.checked = (r.value === strat); });

  const savedMode = lsGet(MODE_KEY) || "（尚未記住）";
  familySetStatus(`目前：永遠極簡=${forced ? "開" : "關"}；預設策略=${strat}；記住的模式=${savedMode}`);

  familyModal.style.display = "flex";
}

function closeFamilySettings(){
  if (!familyModal) return;
  familyModal.style.display = "none";
}

familyCloseBtn?.addEventListener("click", closeFamilySettings);
familyModal?.addEventListener("click", (e) => {
  if (e.target === familyModal) closeFamilySettings();
});

// 永遠極簡 開關
forceSimpleChk?.addEventListener("change", () => {
  if (forceSimpleChk.checked) {
    lsSet(FORCE_SIMPLE_KEY, "1");
    familySetStatus("已設定：之後永遠進入極簡模式（最推薦給長輩）");
  } else {
    lsDel(FORCE_SIMPLE_KEY);
    familySetStatus("已取消：不再永遠極簡");
  }
});

// 預設策略 radio
document.querySelectorAll('input[name="defaultModeRadio"]').forEach(radio => {
  radio.addEventListener("change", () => {
    const v = document.querySelector('input[name="defaultModeRadio"]:checked')?.value || "ask";
    lsSet(DEFAULT_STRATEGY_KEY, v);
    familySetStatus(`已設定：預設進入方式 = ${v}`);
  });
});

// 立刻切換
btnGoSimpleNow?.addEventListener("click", () => {
  showSimpleMode();
  familySetStatus("已切換到極簡模式");
});
btnGoAdvancedNow?.addEventListener("click", () => {
  showAdvancedMode();
  familySetStatus("已切換到進階模式");
});

// 重設記住的模式
btnResetModeRemember?.addEventListener("click", () => {
  lsDel(MODE_KEY);
  familySetStatus("已重設：下次會重新詢問/依預設策略");
});

// 取消永遠極簡（快捷鍵）
btnClearForceSimple?.addEventListener("click", () => {
  lsDel(FORCE_SIMPLE_KEY);
  if (forceSimpleChk) forceSimpleChk.checked = false;
  familySetStatus("已取消：不再永遠極簡");
});

// ✅ 啟動
initLaunchMode();

/* ---- 額外：切換模式時也更新「記住模式」(可選但推薦) ----
   這樣長輩用底部連結切換後，下次會自動進到他最後用的模式
*/
(function patchModeSwitchToRemember() {
  // 包一層不破壞你原函式
  if (typeof showSimpleMode === "function") {
    const _showSimple = showSimpleMode;
    showSimpleMode = function () {
      try { setSavedMode("simple"); } catch {}
      return _showSimple.apply(this, arguments);
    };
  }
  if (typeof showAdvancedMode === "function") {
    const _showAdvanced = showAdvancedMode;
    showAdvancedMode = function () {
      try { setSavedMode("advanced"); } catch {}
      return _showAdvanced.apply(this, arguments);
    };
  }
})();