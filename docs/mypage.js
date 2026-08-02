/**
 * V-Shift マイページ - Firebase Auth / RTDB / Cloud Functions 連携
 * Firebase プロジェクト: RTDB は v-shift、Auth はアプリと同じ設定を使用。
 * ログインできない場合は authDomain/projectId を shiftapp-ver30 に変更してください。
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  onValue,
  get,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";
import {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyDv5JbB81Vs2vzZxXP3Gj5vnRTSWDVU5JU",
  authDomain: "v-shift.firebaseapp.com",
  databaseURL: "https://v-shift-default-rtdb.firebaseio.com",
  projectId: "v-shift",
  storageBucket: "v-shift.appspot.com",
  messagingSenderId: "",
  appId: "",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const functions = getFunctions(app, "us-central1");

const PLAN_NAMES = {
  trial: "トライアル",
  lite: "ライト",
  standard: "スタンダード",
  pro: "プロ",
};

/** summary: 有料プランの階層（アップグレード／ダウングレード判定用） */
const PLAN_ORDER = {
  lite: 1,
  standard: 2,
  pro: 3,
};

const PAID_BASE_PLANS = new Set(["lite", "standard", "pro"]);

/**
 * summary: オンデマンド利用枠が有効か（ondemandEnabled または旧 ondemandActiveUntil）
 */
function isOndemandEnabledLicense(license) {
  if (!license) return false;
  if (license.ondemandEnabled === true) return true;
  const until = license.ondemandActiveUntil;
  if (!until) return false;
  const d = new Date(until);
  return Number.isFinite(d.getTime()) && d.getTime() > Date.now();
}

const SIGNUP_RETRY_KEY = "vshift_signup_retry_v1";
const PAYMENT_RETRY_KEY = "vshift_payment_retry_v1";
const LICENSE_SYNC_ONCE_KEY = "vshift_license_sync_once_v1";
let latestLicenseSnapshot = null;
let ondemandConfirmResolver = null;

/** summary: 画面上部のエラー表示を更新する */
function setPageError(message) {
  const el = document.getElementById("page-error");
  if (!el) return;
  if (!message) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = message;
}

/** summary: Functions/RTDB 由来エラーを読みやすく整形する */
function formatFirebaseError(err) {
  if (!err) return "不明なエラーが発生しました";
  const code = err.code ? String(err.code) : "";
  const message = err.message ? String(err.message) : "不明なエラーが発生しました";
  return code ? `${message}\n(${code})` : message;
}

/**
 * summary: プラン選択ボタン（.plan-card 内の .plan-btn）のみを取得する
 * <remarks>
 * 「契約情報を再取得」など別用途ボタンを含めないこと。
 * </remarks>
 * <returns>プラン選択用ボタンの配列</returns>
 */
function getPlanSelectButtons() {
  return Array.from(document.querySelectorAll(".plan-card .plan-btn"));
}

/**
 * summary: Callable から取得した Stripe Price ID を data-plan に対応するボタンへ反映する
 * <remarks>
 * <list type="bullet">
 * <item><description>data-plan（lite/standard/pro/ondemand）で紐付ける</description></item>
 * <item><description>失敗時は HTML の data-price（本番 ID）のまま → テスト鍵では Checkout が失敗しうる</description></item>
 * </list>
 * </remarks>
 */
async function applyCheckoutPriceIdsToPlanButtons() {
  const buttons = getPlanSelectButtons();
  if (!buttons.length) return;
  try {
    const fn = httpsCallable(functions, "getCheckoutPriceIds");
    const { data } = await fn({});
    const keys = ["lite", "standard", "pro"];
    keys.forEach((key) => {
      const id = data?.[key];
      if (!id) return;
      const btn = buttons.find((b) => b.dataset.plan === key);
      if (btn) btn.dataset.price = String(id);
    });
  } catch (err) {
    console.error("[mypage] getCheckoutPriceIds failed; using HTML data-price defaults", err);
  }
}

/**
 * summary: プラン選択ボタンの表示ラベルを決定する
 * <remarks>
 * <list type="bullet">
 * <item><description>トライアル中は「選択」</description></item>
 * <item><description>契約中プランは「契約中」（無効）</description></item>
 * <item><description>上位プランは「アップグレード」、下位は「ダウングレード」</description></item>
 * </list>
 * </remarks>
 */
function getPlanButtonLabel(currentPlan, targetPlan) {
  if (!PAID_BASE_PLANS.has(targetPlan)) return "選択";
  if (currentPlan === "trial") return "選択";
  if (currentPlan === targetPlan) return "契約中";
  const currentOrder = PLAN_ORDER[currentPlan] || 0;
  const targetOrder = PLAN_ORDER[targetPlan] || 0;
  if (targetOrder > currentOrder) return "アップグレード";
  if (targetOrder < currentOrder) return "ダウングレード";
  return "選択";
}

/**
 * summary: 契約状況に応じてプランカードのボタン表示を更新する
 */
function updatePlanSelectButtons(plan) {
  const currentPlan = (plan || "trial").toLowerCase();
  const buttons = getPlanSelectButtons();
  const sectionTitle = document.getElementById("plan-section-title");
  if (sectionTitle) {
    sectionTitle.textContent = currentPlan === "trial" ? "プラン選択" : "プラン変更";
  }

  buttons.forEach((btn) => {
    const key = (btn.dataset.plan || "").toLowerCase();
    if (!PAID_BASE_PLANS.has(key)) return;

    const isCurrent = PAID_BASE_PLANS.has(currentPlan) && key === currentPlan;
    btn.textContent = getPlanButtonLabel(currentPlan, key);
    btn.disabled = isCurrent;
    btn.title = isCurrent ? "現在契約中のプランです" : "";
    btn.classList.toggle("plan-btn-current", isCurrent);
  });
}

/**
 * summary: プラン選択ボタンに Checkout 用のクリックハンドラを付与する
 * <remarks>
 * priceId 未設定時も画面にエラーを出し、無反応に見えないようにする。
 * </remarks>
 */
function attachPlanButtonHandlers() {
  getPlanSelectButtons().forEach((btn) => {
    btn.addEventListener("click", async () => {
      const priceId = btn.dataset.price;
      if (!priceId) {
        setPageError("プランの価格設定が取得できていません。ページを再読み込みしてから再度お試しください。");
        return;
      }
      btn.disabled = true;
      try {
        const user = auth.currentUser;
        const planLabel = btn.textContent || "プラン変更";
        const email = user?.email || "（メール不明）";
        const confirmed = window.confirm(
          `以下のアカウントで${planLabel}します。\n\nログイン中: ${email}\n\n別アカウントで契約する場合はキャンセルし、ログアウトしてからやり直してください。`
        );
        if (!confirmed) {
          updatePlanSelectButtons(latestLicenseSnapshot?.plan || "trial");
          return;
        }

        const createCheckout = httpsCallable(functions, "createCheckoutSession");
        const { data } = await createCheckout({ priceId });
        if (data?.url) {
          location.href = data.url;
        } else {
          setPageError("決済ページの取得に失敗しました。");
        }
      } catch (err) {
        setPageError(`プラン選択に失敗しました。\n${formatFirebaseError(err)}`);
      } finally {
        updatePlanSelectButtons(latestLicenseSnapshot?.plan || "trial");
      }
    });
  });
}

/** summary: プラン Price ID の取得後にプラン選択 UI を初期化する */
async function initPlanPricingUi() {
  await applyCheckoutPriceIdsToPlanButtons();
  attachPlanButtonHandlers();
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function showSection(sectionId) {
  document.getElementById("auth-section").style.display =
    sectionId === "auth" ? "block" : "none";
  document.getElementById("mypage-section").style.display =
    sectionId === "mypage" ? "block" : "none";
}

/** summary: 削除予約中かどうかのUI（復活導線/操作ブロック）を更新する */
function renderAccountDeletedState(isDeleted, payload) {
  const banner = document.getElementById("account-deleted-banner");
  const sub = document.getElementById("account-deleted-banner-sub");
  const restoreBtn = document.getElementById("restore-account-btn");
  const restoreErr = document.getElementById("restore-account-error");
  const licenseDetails = document.getElementById("license-details");
  const planSection = document.getElementById("plan-cards-section");
  const cancelBtn = document.getElementById("cancel-subscription-btn");
  const deleteBtn = document.getElementById("delete-account-btn");

  if (restoreErr) restoreErr.textContent = "";
  if (!banner || !sub) return;

  if (!isDeleted) {
    banner.style.display = "none";
    if (licenseDetails) licenseDetails.style.display = "";
    if (planSection) planSection.style.display = "";
    if (cancelBtn) cancelBtn.style.display = "";
    if (deleteBtn) deleteBtn.style.display = "";
    if (restoreBtn) restoreBtn.disabled = false;
    return;
  }

  banner.style.display = "block";
  if (licenseDetails) licenseDetails.style.display = "none";
  if (planSection) planSection.style.display = "none";
  if (cancelBtn) cancelBtn.style.display = "none";
  if (deleteBtn) deleteBtn.style.display = "none";

  const purgeAt = payload?.purgeAt || payload?.dataDeleteAt || "";
  const purgeAtText = purgeAt ? `データ削除予定日: ${new Date(purgeAt).toLocaleDateString("ja-JP")}` : "";
  sub.textContent =
    "30日以内であれば、このページから復活できます。\n" +
    "※削除予約中はプラン契約・解約・アカウント削除などの操作はできません。\n" +
    (purgeAtText ? purgeAtText : "");
}

/** summary: RTDB の AccountState を監視し、削除予約中なら UI をブロックする */
function watchAccountState(uid, onState) {
  const stateRef = ref(db, `users/${uid}/AccountState`);
  return onValue(
    stateRef,
    (snap) => {
      const v = snap.exists() ? snap.val() : null;
      onState(v);
    },
    () => {
      // ignore
    }
  );
}

/** summary: 契約状況のローディング表示を切り替える */
function setLicenseLoading(isLoading) {
  const el = document.getElementById("license-loading");
  if (!el) return;
  el.style.display = isLoading ? "block" : "none";
}

/** summary: サインアップ直後のライセンス再試行トークンを開始する */
function markSignupRetryStart() {
  try {
    sessionStorage.setItem(SIGNUP_RETRY_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

/** summary: サインアップ直後の再試行開始時刻（ms）を取得する */
function getSignupRetryStartMs() {
  try {
    const v = sessionStorage.getItem(SIGNUP_RETRY_KEY);
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** summary: サインアップ直後の再試行トークンを消す */
function clearSignupRetryStart() {
  try {
    sessionStorage.removeItem(SIGNUP_RETRY_KEY);
  } catch {
    // ignore
  }
}

/** summary: 決済完了直後のライセンス再試行トークンを開始する */
function markPaymentRetryStart() {
  try {
    sessionStorage.setItem(PAYMENT_RETRY_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

/** summary: 決済完了直後の再試行開始時刻（ms）を取得する */
function getPaymentRetryStartMs() {
  try {
    const v = sessionStorage.getItem(PAYMENT_RETRY_KEY);
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** summary: 決済完了直後の再試行トークンを消す */
function clearPaymentRetryStart() {
  try {
    sessionStorage.removeItem(PAYMENT_RETRY_KEY);
  } catch {
    // ignore
  }
}

/** summary: plan など契約フィールドを持つライセンスかどうか */
function isContractLicense(license) {
  return Boolean(license && typeof license.plan === "string" && license.plan.length > 0);
}

/** summary: RTDB の permission_denied かどうか（licenses ルートは Web から読めない環境がある） */
function isPermissionDeniedError(err) {
  const code = err?.code ? String(err.code) : "";
  const msg = err?.message ? String(err.message) : "";
  return (
    code === "PERMISSION_DENIED" ||
    /permission_denied/i.test(msg)
  );
}

/**
 * summary: users/{uid}/License と licenses/{uid} をマージする（usedBytes は端末合算で別途取得）
 */
function mergeLicenseSnapshots(userScoped, rootScoped) {
  const u =
    userScoped && typeof userScoped === "object" && !Array.isArray(userScoped) ? userScoped : null;
  const r =
    rootScoped && typeof rootScoped === "object" && !Array.isArray(rootScoped) ? rootScoped : null;
  if (!u && !r) return null;

  const primary = isContractLicense(u) ? u : isContractLicense(r) ? r : u || r;
  return { ...primary };
}

const TRIAL_PERIOD_KEY = "trial";

/** summary: 請求期間キー（端末 acknowledgedRenewedAt 比較用） */
function getBillingPeriodKey(license) {
  const plan = (license?.plan || "trial").toLowerCase();
  if (plan === "trial") return TRIAL_PERIOD_KEY;
  return license?.renewedAt ?? "";
}

/** summary: 旧スキーマの usedBytes をフォールバック読取する */
async function loadLegacyUsedBytes(uid) {
  const candidates = [
    `usage/${uid}/usedBytes`,
    `users/${uid}/Usage/usedBytes`,
    `users/${uid}/License/usedBytes`,
    `licenses/${uid}/usedBytes`,
  ];
  for (const path of candidates) {
    try {
      const snap = await get(ref(db, path));
      const val = snap.val();
      if (typeof val === "number" && Number.isFinite(val)) return val;
      if (typeof val === "string" && val && !Number.isNaN(Number(val))) return Number(val);
    } catch {
      // ignore
    }
  }
  return 0;
}

/** summary: usage/{uid}/devices を合算して通信量を取得する */
async function loadAggregatedUsedBytes(uid, license, devicesSnapshot) {
  const periodKey = getBillingPeriodKey(license || { plan: "trial" });
  let devices = devicesSnapshot;
  if (devices === undefined) {
    try {
      const snap = await get(ref(db, `usage/${uid}/devices`));
      devices = snap.exists() ? snap.val() : null;
    } catch {
      devices = null;
    }
  }
  if (!devices || typeof devices !== "object") {
    return loadLegacyUsedBytes(uid);
  }
  let total = 0;
  for (const entry of Object.values(devices)) {
    if (!entry || typeof entry !== "object") continue;
    const ack = entry.acknowledgedRenewedAt ?? "";
    if (ack !== periodKey) continue;
    const used = Number(entry.usedBytes);
    if (Number.isFinite(used)) total += used;
  }
  return total;
}

/** summary: ライセンスに合算 usedBytes を付与する */
async function attachLicenseUsage(uid, license, devicesSnapshot) {
  if (!license) return null;
  const usedBytes = await loadAggregatedUsedBytes(uid, license, devicesSnapshot);
  return { ...license, usedBytes };
}

/** summary: RTDB からライセンスを単発で取得（user 配下優先、必要時のみ licenses を試す）する */
async function fetchLicenseOnce(uid) {
  let userScoped = null;
  let rootScoped = null;
  try {
    const snap = await get(ref(db, `users/${uid}/License`));
    if (snap.exists()) userScoped = snap.val();
  } catch {
    // ignore
  }
  if (isContractLicense(userScoped)) {
    return mergeLicenseSnapshots(userScoped, null);
  }
  try {
    const snap = await get(ref(db, `licenses/${uid}`));
    if (snap.exists()) rootScoped = snap.val();
  } catch (err) {
    if (!isPermissionDeniedError(err)) {
      // ignore（ルール拒否は想定内）
    }
  }
  return mergeLicenseSnapshots(userScoped, rootScoped);
}

/** summary: サインアップ直後だけライセンスを再試行して取得する（5秒後開始、3秒間隔、最大30秒） */
async function loadLicenseWithRetryAfterSignup(uid) {
  const startMs = getSignupRetryStartMs();
  if (!startMs) return { handled: false };

  const maxTotalMs = 30_000;
  const initialDelayMs = 5_000;
  const intervalMs = 3_000;
  const deadline = startMs + maxTotalMs;

  // 既に期限切れなら通常フローへ
  if (Date.now() > deadline) {
    clearSignupRetryStart();
    return { handled: false };
  }

  setLicenseLoading(true);
  setPageError("");

  const waitMs = Math.max(0, startMs + initialDelayMs - Date.now());
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }

  while (Date.now() <= deadline) {
    const license = await fetchLicenseOnce(uid);
    if (license) {
      clearSignupRetryStart();
      setLicenseLoading(false);
      renderLicense(await attachLicenseUsage(uid, license));
      return { handled: true, license };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  clearSignupRetryStart();
  setLicenseLoading(false);
  setPageError("契約状況が読み取れませんでした。");
  return { handled: true, license: null };
}

/** summary: Stripe から契約情報を RTDB へ同期する（Webhook 待ちのフォールバック） */
async function syncLicenseFromStripeCallable() {
  try {
    const fn = httpsCallable(functions, "syncSubscriptionLicense");
    const { data } = await fn({});
    return Boolean(data?.synced);
  } catch (err) {
    console.warn("[mypage] syncSubscriptionLicense failed", err);
    return false;
  }
}

/** summary: トライアル表示のままのとき、セッション1回だけ Stripe から契約同期を試す */
async function maybeSyncLicenseOnceIfTrial(uid) {
  try {
    if (sessionStorage.getItem(LICENSE_SYNC_ONCE_KEY)) return;
  } catch {
    return;
  }
  const license = await fetchLicenseOnce(uid);
  if (isContractLicense(license)) return;

  const ok = await syncLicenseFromStripeCallable();
  try {
    sessionStorage.setItem(LICENSE_SYNC_ONCE_KEY, "1");
  } catch {
    // ignore
  }
  if (!ok) return;

  const updated = await fetchLicenseOnce(uid);
  if (isContractLicense(updated)) {
    setPageError("");
    renderLicense(await attachLicenseUsage(uid, updated));
  }
}

/** summary: 「契約情報を再取得」ボタンのクリック処理 */
async function handleSyncLicenseButtonClick() {
  const user = auth.currentUser;
  if (!user) return;

  const btn = document.getElementById("sync-license-btn");
  const originalText = btn?.textContent || "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "取得中…";
  }
  setPageError("");

  try {
    const ok = await syncLicenseFromStripeCallable();
    const license = await fetchLicenseOnce(user.uid);
    if (ok && isContractLicense(license)) {
      renderLicense(await attachLicenseUsage(user.uid, license));
      return;
    }
    setPageError(
      "契約情報を取得できませんでした。お支払い直後の場合は数分待ってから再度お試しください。"
    );
    if (license) renderLicense(await attachLicenseUsage(user.uid, license));
  } catch (err) {
    setPageError(`契約情報の取得に失敗しました。\n${formatFirebaseError(err)}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

/** summary: 決済完了直後だけライセンスを再試行して取得する（即時開始、3秒間隔、最大60秒） */
async function loadLicenseWithRetryAfterPayment(uid) {
  const startMs = getPaymentRetryStartMs();
  if (!startMs) return { handled: false };

  const maxTotalMs = 60_000;
  const intervalMs = 3_000;
  const deadline = startMs + maxTotalMs;

  if (Date.now() > deadline) {
    clearPaymentRetryStart();
    return { handled: false };
  }

  setLicenseLoading(true);
  setPageError("");

  await syncLicenseFromStripeCallable();

  while (Date.now() <= deadline) {
    const license = await fetchLicenseOnce(uid);
    if (isContractLicense(license)) {
      clearPaymentRetryStart();
      setLicenseLoading(false);
      renderLicense(license);
      return { handled: true, license };
    }
    await syncLicenseFromStripeCallable();
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  clearPaymentRetryStart();
  setLicenseLoading(false);
  setPageError(
    "お支払いは完了していますが、契約情報の反映に時間がかかっています。数分後に再読み込みするか、反映されない場合はサポートへお問い合わせください。"
  );
  return { handled: true, license: null };
}

/** summary: ナビゲーション（ログイン状態）を切り替える */
function renderNav(user) {
  const authButtons = document.getElementById("nav-auth-buttons");
  const account = document.getElementById("nav-account");
  const nameEl = document.getElementById("nav-account-name");
  const accountMenu = document.getElementById("nav-account-menu");
  const planEmailEl = document.getElementById("plan-account-email-value");

  if (planEmailEl) {
    planEmailEl.textContent = user?.email || "---";
  }

  if (!authButtons || !account || !nameEl) return;

  if (user) {
    authButtons.style.display = "none";
    account.style.display = "block";
    nameEl.textContent = user.displayName || user.email || "---";
  } else {
    authButtons.style.display = "flex";
    account.style.display = "none";
    if (accountMenu) accountMenu.style.display = "none";
  }
}

function showPaymentMessages() {
  const params = new URLSearchParams(location.search);
  const paymentSuccess = document.getElementById("payment-success-msg");
  const paymentCancel = document.getElementById("payment-cancel-msg");
  if (params.get("payment") === "success") {
    paymentSuccess.style.display = "block";
    paymentCancel.style.display = "none";
    markPaymentRetryStart();
    window.history.replaceState({}, "", location.pathname);
  } else if (params.get("payment") === "cancel") {
    paymentCancel.style.display = "block";
    paymentSuccess.style.display = "none";
    window.history.replaceState({}, "", location.pathname);
  }
}

/** summary: トライアル/未契約時の使用量（端末合算）を RTDB から取得する */
async function loadTrialUsedBytes(uid) {
  return loadAggregatedUsedBytes(uid, { plan: "trial", renewedAt: null });
}

/** summary: 契約状況UIをレンダリングする */
function renderLicense(license) {
  latestLicenseSnapshot = license || null;
  const plan = license?.plan || "trial";
  const limitBytes = license?.limitBytes ?? 50 * 1024 * 1024;
  const usedBytes = license?.usedBytes ?? 0;
  const cancelAtPeriodEnd = license?.cancelAtPeriodEnd === true;
  const cancelAt = license?.cancelAt ? new Date(license.cancelAt) : null;
  const cancelledAt = license?.cancelledAt ? new Date(license.cancelledAt) : null;
  const dataDeleteAt = license?.dataDeleteAt ? new Date(license.dataDeleteAt) : null;
  const ondemandActive = isOndemandEnabledLicense(license);
  const limitReached = limitBytes > 0 && usedBytes >= limitBytes;

  // 詳細表示（初回レンダリングで表示）
  const licenseDetails = document.getElementById("license-details");
  if (licenseDetails) licenseDetails.style.display = "";

  document.getElementById("plan-name").textContent = PLAN_NAMES[plan] || plan;
  document.getElementById("usage-text").textContent =
    formatBytes(usedBytes) + " / " + formatBytes(limitBytes);

  const pct = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;
  const bar = document.getElementById("usage-bar");
  bar.style.width = Math.min(pct, 100) + "%";
  bar.classList.remove("warn", "danger");
  if (pct >= 90) bar.classList.add("danger");
  else if (pct >= 85) bar.classList.add("warn");

  const renewedAt = license?.renewedAt;
  const renewedAtValueEl = document.getElementById("renewed-at-value");
  const renewedAtRow = document.getElementById("renewed-at");
  if (plan === "trial") {
    renewedAtValueEl.textContent = "";
    if (renewedAtRow) renewedAtRow.style.display = "none";
  } else {
    if (renewedAtRow) renewedAtRow.style.display = "";
    renewedAtValueEl.textContent = renewedAt
      ? new Date(renewedAt).toLocaleDateString("ja-JP")
      : "---";
  }

  const cancelStatus = document.getElementById("cancel-status");
  if (cancelStatus) {
    if (plan === "canceled") {
      cancelStatus.style.display = "block";
      const cancelledAtText =
        cancelledAt && Number.isFinite(cancelledAt.getTime())
          ? `解約日: ${cancelledAt.toLocaleDateString("ja-JP")}`
          : "解約済み";
      const deleteAtText =
        dataDeleteAt && Number.isFinite(dataDeleteAt.getTime())
          ? ` / データ削除予定日: ${dataDeleteAt.toLocaleDateString("ja-JP")}`
          : "";
      cancelStatus.textContent = `解約済み（${cancelledAtText}${deleteAtText}）`;
    } else if (plan !== "trial" && cancelAtPeriodEnd) {
      cancelStatus.style.display = "block";
      const untilText =
        cancelAt && Number.isFinite(cancelAt.getTime())
          ? `（${cancelAt.toLocaleDateString("ja-JP")}まで利用可）`
          : "（次回更新日まで利用可）";
      cancelStatus.textContent = `解約予約中 ${untilText}（更新日以降はトライアル扱いとなります）`;
    } else {
      cancelStatus.style.display = "none";
      cancelStatus.textContent = "";
    }
  }

  const cancelBtn = document.getElementById("cancel-subscription-btn");
  if (cancelBtn) cancelBtn.style.display = plan === "trial" ? "none" : "";

  // オンデマンド利用枠 ON/OFF（有料プラン契約中なら表示）
  updateOndemandToggleUi({ plan, ondemandActive });

  const planSection = document.getElementById("plan-cards-section");
  if (planSection) {
    planSection.style.display = "";
  }

  updatePlanSelectButtons(plan);

  const ondemandStatus = document.getElementById("ondemand-status");
  if (ondemandStatus) {
    if (!PAID_BASE_PLANS.has(plan)) {
      ondemandStatus.style.display = "none";
      ondemandStatus.textContent = "";
    } else {
      ondemandStatus.style.display = "block";
      ondemandStatus.textContent = ondemandActive
        ? "オンデマンド利用枠: 有効（手動で OFF にするまで継続）"
        : "オンデマンド利用枠: 無効";
    }
  }
}

/**
 * summary: RTDB のライセンス情報を監視する
 * Web ルールでは licenses/{uid} が読めないことが多いため users/{uid}/License を優先し、
 * plan が揃っている間は licenses を購読しない（permission_denied を出さない）。
 */
function watchLicense(uid, onLicense, onError) {
  const userScopedRef = ref(db, `users/${uid}/License`);
  const devicesRef = ref(db, `usage/${uid}/devices`);
  let unsubscribeRoot = null;
  let latestUser = null;
  let latestRoot = null;
  let latestDevices = null;

  const stopRootListener = () => {
    if (!unsubscribeRoot) return;
    try {
      unsubscribeRoot();
    } finally {
      unsubscribeRoot = null;
      latestRoot = null;
    }
  };

  const emitMerged = async () => {
    const merged = mergeLicenseSnapshots(latestUser, latestRoot);
    if (!merged) {
      onLicense(null);
      return;
    }
    onLicense(await attachLicenseUsage(uid, merged, latestDevices));
  };

  const ensureRootListener = () => {
    if (unsubscribeRoot) return;
    const rootRef = ref(db, `licenses/${uid}`);
    unsubscribeRoot = onValue(
      rootRef,
      (snap) => {
        latestRoot = snap.exists() ? snap.val() : null;
        void emitMerged();
      },
      (err) => {
        if (!isPermissionDeniedError(err) && onError) onError(err);
      }
    );
  };

  const unsubscribeDevices = onValue(
    devicesRef,
    (snap) => {
      latestDevices = snap.exists() ? snap.val() : null;
      void emitMerged();
    },
    (err) => {
      if (!isPermissionDeniedError(err) && onError) onError(err);
    }
  );

  const unsubscribeUserScoped = onValue(
    userScopedRef,
    (snap) => {
      latestUser = snap.exists() ? snap.val() : null;
      if (!snap.exists()) {
        ensureRootListener();
        if (!unsubscribeRoot) void emitMerged();
        return;
      }
      if (isContractLicense(latestUser)) {
        stopRootListener();
        void emitMerged();
        return;
      }
      ensureRootListener();
      void emitMerged();
    },
    (err) => {
      ensureRootListener();
      if (onError) onError(err);
    }
  );

  return () => {
    try {
      unsubscribeUserScoped?.();
      unsubscribeDevices?.();
    } finally {
      stopRootListener();
    }
  };
}

/** summary: オンデマンド利用枠トグルボタンの表示/文言を最新状態で更新する */
function updateOndemandToggleUi(state) {
  const toggleOndemandBtn = document.getElementById("toggle-ondemand-btn");
  if (!toggleOndemandBtn) return;

  const plan = state?.plan || "trial";
  const ondemandActive = state?.ondemandActive === true;

  const canToggle = PAID_BASE_PLANS.has(plan);
  toggleOndemandBtn.style.display = canToggle ? "" : "none";
  toggleOndemandBtn.textContent = ondemandActive
    ? "オンデマンド利用枠を無効にする"
    : "オンデマンド利用枠を有効にする";
}

/** summary: 従量課金の切り替え確認モーダルを開く（ユーザーの選択を Promise で返す） */
function openOndemandConfirmModal(nextEnable) {
  const backdrop = document.getElementById("ondemand-confirm-backdrop");
  const modal = document.getElementById("ondemand-confirm-modal");
  const msg = document.getElementById("ondemand-confirm-message");
  const ok = document.getElementById("ondemand-confirm-ok");
  const cancel = document.getElementById("ondemand-confirm-cancel");
  if (!backdrop || !modal || !msg || !ok || !cancel) return Promise.resolve(false);

  // 多重起動防止（前回が残っている場合は否決）
  if (ondemandConfirmResolver) return Promise.resolve(false);

  const title = nextEnable ? "オンデマンド利用枠を有効にしますか？" : "オンデマンド利用枠を無効にしますか？";
  const body = nextEnable
    ? [
        title,
        "",
        "オンデマンド利用枠は後払いです（¥3 / MB）。",
        "プランに含まれる通信量を使い切った後の超過分のみ、次回更新日の請求に加算されます。",
        "ON の間は手動で OFF にするまで有効です。",
        "※誤操作防止のため、内容を確認のうえ「切り替える」を押してください。",
      ].join("\n")
    : [
        title,
        "",
        "OFF に戻しても、OFF にするまでに発生した超過分は次回更新日に請求されます。",
        "※オンデマンド利用枠の新規発生は止まります。",
      ].join("\n");

  msg.textContent = body;
  ok.textContent = nextEnable ? "有効にする" : "無効にする";

  backdrop.style.display = "block";
  modal.style.display = "flex";

  return new Promise((resolve) => {
    ondemandConfirmResolver = resolve;
  });
}

/** summary: 従量課金の切り替え確認モーダルを閉じる（結果を返す） */
function closeOndemandConfirmModal(result) {
  const backdrop = document.getElementById("ondemand-confirm-backdrop");
  const modal = document.getElementById("ondemand-confirm-modal");
  try {
    backdrop && (backdrop.style.display = "none");
    modal && (modal.style.display = "none");
  } finally {
    const r = ondemandConfirmResolver;
    ondemandConfirmResolver = null;
    r && r(Boolean(result));
  }
}

/** summary: 従量課金の切り替え確認モーダルのイベントを初期化する */
function initOndemandConfirmModalEvents() {
  const backdrop = document.getElementById("ondemand-confirm-backdrop");
  const ok = document.getElementById("ondemand-confirm-ok");
  const cancel = document.getElementById("ondemand-confirm-cancel");
  const modal = document.getElementById("ondemand-confirm-modal");

  ok?.addEventListener("click", () => closeOndemandConfirmModal(true));
  cancel?.addEventListener("click", () => closeOndemandConfirmModal(false));
  backdrop?.addEventListener("click", () => closeOndemandConfirmModal(false));

  // Esc で閉じる（delete modal と共存）
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ondemandConfirmResolver) {
      closeOndemandConfirmModal(false);
    }
  });

  // モーダル外クリックにも対応（念のため）
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeOndemandConfirmModal(false);
  });
}

/** summary: 従量課金トグルのクリック処理（Functions呼び出し）を実行する */
async function handleToggleOndemandClick() {
  const btn = document.getElementById("toggle-ondemand-btn");
  if (!btn) return;

  const plan = latestLicenseSnapshot?.plan || "trial";
  const ondemandActive = isOndemandEnabledLicense(latestLicenseSnapshot);

  if (!PAID_BASE_PLANS.has(plan)) {
    setPageError("オンデマンド利用枠の切り替えは、有料プラン契約中のみ操作できます。");
    updateOndemandToggleUi({ plan, ondemandActive });
    return;
  }

  const confirmed = await openOndemandConfirmModal(!ondemandActive);
  if (!confirmed) {
    updateOndemandToggleUi({ plan, ondemandActive });
    return;
  }

  const originalText = btn.textContent || "";
  btn.disabled = true;
  btn.textContent = "処理中…";
  try {
    const fnName = ondemandActive ? "deactivateOndemand" : "activateOndemand";
    const fn = httpsCallable(functions, fnName);
    await fn({});
    setPageError("");
    // 反映はライセンス監視の更新を待つが、体感のため先にUIだけ戻す
    updateOndemandToggleUi({ plan, ondemandActive: !ondemandActive });
  } catch (err) {
    setPageError(`オンデマンド利用枠の切り替えに失敗しました。\n${formatFirebaseError(err)}`);
    updateOndemandToggleUi({ plan, ondemandActive });
  } finally {
    btn.disabled = false;
    if (btn.textContent === "処理中…") btn.textContent = originalText;
  }
}

/** summary: 従量課金トグルボタンへクリックハンドラを一度だけ紐付ける */
function attachOndemandToggleHandler() {
  const btn = document.getElementById("toggle-ondemand-btn");
  if (!btn) return;
  if (btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    await handleToggleOndemandClick();
  });
}

onAuthStateChanged(auth, (user) => {
  setPageError("");
  renderNav(user);
  if (user) {
    showSection("mypage");
    showPaymentMessages();

    // いったん通常表示（=削除予約ではない想定）へ。監視で deleted=true が来たら即ブロックする。
    renderAccountDeletedState(false, null);

    // AccountState（削除予約中）監視
    try {
      watchAccountState(user.uid, (state) => {
        const deleted = state?.deleted === true;
        renderAccountDeletedState(deleted, state || {});
      });
    } catch {
      // ignore
    }

    void maybeSyncLicenseOnceIfTrial(user.uid);

    document.getElementById("sync-license-btn")?.addEventListener("click", () => {
      void handleSyncLicenseButtonClick();
    });

    // 決済直後は Webhook 反映待ちのためリトライで吸収する
    loadLicenseWithRetryAfterPayment(user.uid).then((paymentRes) => {
      if (paymentRes?.handled && paymentRes.license) {
        watchLicense(
          user.uid,
          async (license) => {
            if (license) {
              renderLicense(license);
              if (license?.accountDeleted === true) {
                renderAccountDeletedState(true, license);
              }
              return;
            }
            const usedBytes = await loadTrialUsedBytes(user.uid);
            renderLicense({
              plan: "trial",
              limitBytes: 50 * 1024 * 1024,
              usedBytes,
              renewedAt: null,
            });
          },
          async () => {
            const usedBytes = await loadTrialUsedBytes(user.uid);
            renderLicense({
              plan: "trial",
              limitBytes: 50 * 1024 * 1024,
              usedBytes,
              renewedAt: null,
            });
            setPageError("契約情報の読み取りに失敗しました。");
          }
        );
        return;
      }
      if (paymentRes?.handled) {
        watchLicense(
          user.uid,
          async (license) => {
            if (license) {
              renderLicense(license);
              if (license?.accountDeleted === true) {
                renderAccountDeletedState(true, license);
              }
              return;
            }
            const usedBytes = await loadTrialUsedBytes(user.uid);
            renderLicense({
              plan: "trial",
              limitBytes: 50 * 1024 * 1024,
              usedBytes,
              renewedAt: null,
            });
          },
          async () => {
            const usedBytes = await loadTrialUsedBytes(user.uid);
            renderLicense({
              plan: "trial",
              limitBytes: 50 * 1024 * 1024,
              usedBytes,
              renewedAt: null,
            });
          }
        );
        return;
      }

      // サインアップ直後は、Functions側の初期書き込み待ちのためリトライで吸収する
      return loadLicenseWithRetryAfterSignup(user.uid);
    }).then((res) => {
      if (!res) return;
      if (res?.handled && res.license) {
        // 取得できた後は通常監視へ
        watchLicense(
          user.uid,
          async (license) => {
            if (license) {
              renderLicense(license);
              // ライセンス側にフラグがある場合も削除予約UIへ反映（AccountState が読めない環境向け）
              if (license?.accountDeleted === true) {
                renderAccountDeletedState(true, license);
              }
              return;
            }
            const usedBytes = await loadTrialUsedBytes(user.uid);
            renderLicense({
              plan: "trial",
              limitBytes: 50 * 1024 * 1024,
              usedBytes,
              renewedAt: null,
            });
          },
          async () => {
            // サインアップ直後以外の監視エラーは、従来どおり trial 表示＋詳細エラー
            const usedBytes = await loadTrialUsedBytes(user.uid);
            renderLicense({
              plan: "trial",
              limitBytes: 50 * 1024 * 1024,
              usedBytes,
              renewedAt: null,
            });
            setPageError("契約情報の読み取りに失敗しました。");
          }
        );
        return;
      }

      // 通常フロー（従来の watch + エラー表示）
      watchLicense(
        user.uid,
        async (license) => {
          if (license) {
            setLicenseLoading(false);
            renderLicense(license);
            if (license?.accountDeleted === true) {
              renderAccountDeletedState(true, license);
            }
            return;
          }

          const usedBytes = await loadTrialUsedBytes(user.uid);
          renderLicense({
            plan: "trial",
            limitBytes: 50 * 1024 * 1024,
            usedBytes,
            renewedAt: null,
          });
        },
        async (err) => {
          setLicenseLoading(false);
          const usedBytes = await loadTrialUsedBytes(user.uid);
          renderLicense({
            plan: "trial",
            limitBytes: 50 * 1024 * 1024,
            usedBytes,
            renewedAt: null,
          });
          setPageError(`契約情報の読み取りに失敗しました。\n${formatFirebaseError(err)}`);
        }
      );
    });
  } else {
    showSection("auth");
    closeDeleteModal();
    renderAccountDeletedState(false, null);
    const hash = (location.hash || "").toLowerCase();
    if (hash === "#signup") {
      document.querySelector(".auth-card").style.display = "none";
      document.getElementById("signup-card").style.display = "block";
    } else {
      document.getElementById("signup-card").style.display = "none";
      document.querySelector(".auth-card").style.display = "block";
    }
  }
});

document.getElementById("restore-account-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("restore-account-btn");
  const errEl = document.getElementById("restore-account-error");
  const okEl = document.getElementById("restore-success-msg");
  if (errEl) errEl.textContent = "";
  if (okEl) okEl.style.display = "none";
  btn.disabled = true;
  try {
    const user = auth.currentUser;
    if (!user) {
      if (errEl) errEl.textContent = "ログインが必要です。";
      return;
    }
    const fn = httpsCallable(functions, "restoreAccount");
    const { data } = await fn({});
    if (data?.restored === false) {
      if (errEl) errEl.textContent = "このアカウントは削除予約中ではありません。";
      return;
    }
    // 監視が追従するが、即時反映のため成功メッセージを表示
    setPageError("");
    if (okEl) okEl.style.display = "block";
  } catch (err) {
    if (errEl) errEl.textContent = formatFirebaseError(err) || "復活に失敗しました";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const btn = document.getElementById("login-btn");
  const errEl = document.getElementById("auth-error");
  errEl.textContent = "";
  btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errEl.textContent = err.message || "ログインに失敗しました";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("signup-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("signup-email").value;
  const password = document.getElementById("signup-password").value;
  const displayName = document.getElementById("signup-displayname").value;
  const btn = document.getElementById("signup-btn");
  const errEl = document.getElementById("signup-error");
  errEl.textContent = "";
  btn.disabled = true;
  try {
    // サインアップ直後の初期ライセンス書き込み待ち対策（onAuthStateChanged より先にフラグを立てる）
    markSignupRetryStart();
    await createUserWithEmailAndPassword(auth, email, password);
    if (auth.currentUser && displayName) {
      await updateProfile(auth.currentUser, { displayName });
    }
  } catch (err) {
    errEl.textContent = err.message || "アカウント作成に失敗しました";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("show-signup")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelector(".auth-card").style.display = "none";
  document.getElementById("signup-card").style.display = "block";
});

document.getElementById("show-login")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("signup-card").style.display = "none";
  document.querySelector(".auth-card").style.display = "block";
});

initPlanPricingUi();
initOndemandConfirmModalEvents();
attachOndemandToggleHandler();

document.getElementById("logout-btn")?.addEventListener("click", async () => {
  await signOut(auth);
});

document.getElementById("nav-logout-btn")?.addEventListener("click", async () => {
  await signOut(auth);
});

document.getElementById("nav-account-btn")?.addEventListener("click", () => {
  const menu = document.getElementById("nav-account-menu");
  if (!menu) return;
  menu.style.display = menu.style.display === "none" ? "block" : "none";
});

document.addEventListener("click", (e) => {
  const btn = document.getElementById("nav-account-btn");
  const menu = document.getElementById("nav-account-menu");
  if (!btn || !menu) return;
  if (btn.contains(e.target) || menu.contains(e.target)) return;
  menu.style.display = "none";
});

/**
 * 解約（サブスクリプション停止）のために Stripe Customer Portal を開く
 */
async function openCancelPortal(buttonEl) {
  buttonEl.disabled = true;
  try {
    const user = auth.currentUser;
    if (!user) {
      setPageError("ログインが必要です。");
      return;
    }

    const createPortal = httpsCallable(functions, "createBillingPortalSession");
    const { data } = await createPortal({});
    if (data?.url) {
      location.href = data.url;
    } else {
      setPageError("解約ページの取得に失敗しました。");
    }
  } catch (err) {
    setPageError(`解約手続きの開始に失敗しました。\n${formatFirebaseError(err)}`);
  } finally {
    buttonEl.disabled = false;
  }
}

document.getElementById("cancel-subscription-btn")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!btn) return;
  await openCancelPortal(btn);
});

/** summary: アカウント削除モーダルを初期化して開く */
function openDeleteModal() {
  const backdrop = document.getElementById("delete-modal-backdrop");
  const modal = document.getElementById("delete-modal");
  const body = document.getElementById("delete-modal-body");
  const progress = document.getElementById("delete-progress");
  const pwd = document.getElementById("delete-password");
  const agree = document.getElementById("delete-agree");
  const exec = document.getElementById("delete-execute");
  const err = document.getElementById("delete-error");

  if (pwd) pwd.value = "";
  if (agree) agree.checked = false;
  if (exec) exec.disabled = true;
  if (err) err.textContent = "";
  if (body) body.style.display = "block";
  if (progress) progress.style.display = "none";
  if (backdrop) backdrop.style.display = "block";
  if (modal) modal.style.display = "flex";
}

/** summary: アカウント削除モーダルを閉じ、入力をリセットする */
function closeDeleteModal() {
  const backdrop = document.getElementById("delete-modal-backdrop");
  const modal = document.getElementById("delete-modal");
  const body = document.getElementById("delete-modal-body");
  const progress = document.getElementById("delete-progress");
  const pwd = document.getElementById("delete-password");
  const agree = document.getElementById("delete-agree");
  const exec = document.getElementById("delete-execute");
  const err = document.getElementById("delete-error");

  if (pwd) pwd.value = "";
  if (agree) agree.checked = false;
  if (exec) exec.disabled = true;
  if (err) err.textContent = "";
  if (body) body.style.display = "block";
  if (progress) progress.style.display = "none";
  if (backdrop) backdrop.style.display = "none";
  if (modal) modal.style.display = "none";
}

document.getElementById("delete-account-btn")?.addEventListener("click", () => {
  openDeleteModal();
});

document.getElementById("delete-cancel")?.addEventListener("click", () => {
  closeDeleteModal();
});

document.getElementById("delete-modal-backdrop")?.addEventListener("click", () => {
  closeDeleteModal();
});

document
  .getElementById("delete-agree")
  ?.addEventListener("change", (e) => {
    const pwd = document.getElementById("delete-password").value;
    document.getElementById("delete-execute").disabled =
      !e.target.checked || !pwd;
  });

document
  .getElementById("delete-password")
  ?.addEventListener("input", () => {
    const agree = document.getElementById("delete-agree").checked;
    const pwd = document.getElementById("delete-password").value;
    document.getElementById("delete-execute").disabled = !agree || !pwd;
  });

document.getElementById("delete-execute")?.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user?.email) return;

  const password = document.getElementById("delete-password").value;
  if (!password) {
    const errEl = document.getElementById("delete-error");
    if (errEl) errEl.textContent = "パスワードを入力してください";
    return;
  }

  const executeBtn = document.getElementById("delete-execute");
  executeBtn.disabled = true;
  try {
    const body = document.getElementById("delete-modal-body");
    const progress = document.getElementById("delete-progress");
    if (body) body.style.display = "none";
    if (progress) progress.style.display = "flex";

    const credential = EmailAuthProvider.credential(user.email, password);
    await reauthenticateWithCredential(user, credential);

    const deleteAccountFn = httpsCallable(functions, "deleteAccount");
    await deleteAccountFn();
    await signOut(auth);
    closeDeleteModal();
  } catch (err) {
    const errEl = document.getElementById("delete-error");
    if (errEl) errEl.textContent = formatFirebaseError(err) || "削除に失敗しました";
    const body = document.getElementById("delete-modal-body");
    const progress = document.getElementById("delete-progress");
    if (body) body.style.display = "block";
    if (progress) progress.style.display = "none";
  } finally {
    executeBtn.disabled = false;
  }
});

// オンデマンド利用枠は有料プラン契約中にトグルで切り替える（単独プランとしては選択不可）
