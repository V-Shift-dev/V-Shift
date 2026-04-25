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
  ondemand: "従量課金",
};

const SIGNUP_RETRY_KEY = "vshift_signup_retry_v1";

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

/** summary: Callable から取得した Stripe Price ID をプラン順の .plan-btn に反映する */
async function applyCheckoutPriceIdsToPlanButtons() {
  const buttons = Array.from(document.querySelectorAll(".plan-btn"));
  if (!buttons.length) return;
  try {
    const fn = httpsCallable(functions, "getCheckoutPriceIds");
    const { data } = await fn({});
    const keys = ["lite", "standard", "pro", "ondemand"];
    keys.forEach((key, i) => {
      const id = data?.[key];
      if (id && buttons[i]) buttons[i].dataset.price = String(id);
    });
  } catch (err) {
    // 失敗時は HTML の data-price（本番 ID）のまま → テスト鍵では Checkout が失敗しうる
    console.error("[mypage] getCheckoutPriceIds failed; using HTML data-price defaults", err);
  }
}

/** summary: プラン選択ボタンに Checkout 用のクリックハンドラを付与する */
function attachPlanButtonHandlers() {
  document.querySelectorAll(".plan-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const priceId = btn.dataset.price;
      if (!priceId) return;
      btn.disabled = true;
      try {
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
        btn.disabled = false;
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

/** summary: RTDB からライセンスを単発で取得（user配下→root）する */
async function fetchLicenseOnce(uid) {
  const candidates = [`users/${uid}/License`, `licenses/${uid}`];
  for (const path of candidates) {
    try {
      const snap = await get(ref(db, path));
      if (snap.exists()) return snap.val();
    } catch {
      // ignore and try next
    }
  }
  return null;
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
      renderLicense(license);
      return { handled: true, license };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  clearSignupRetryStart();
  setLicenseLoading(false);
  setPageError("契約状況が読み取れませんでした。");
  return { handled: true, license: null };
}

/** summary: ナビゲーション（ログイン状態）を切り替える */
function renderNav(user) {
  const authButtons = document.getElementById("nav-auth-buttons");
  const account = document.getElementById("nav-account");
  const nameEl = document.getElementById("nav-account-name");
  const mypageItem = document.getElementById("nav-mypage-item");
  const accountMenu = document.getElementById("nav-account-menu");

  if (!authButtons || !account || !nameEl || !mypageItem) return;

  if (user) {
    authButtons.style.display = "none";
    account.style.display = "block";
    mypageItem.style.display = "";
    nameEl.textContent = user.displayName || user.email || "---";
  } else {
    authButtons.style.display = "flex";
    account.style.display = "none";
    mypageItem.style.display = "none";
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
    window.history.replaceState({}, "", location.pathname);
  } else if (params.get("payment") === "cancel") {
    paymentCancel.style.display = "block";
    paymentSuccess.style.display = "none";
    window.history.replaceState({}, "", location.pathname);
  }
}

/** summary: トライアル/未契約時の使用量を RTDB から可能な範囲で取得する */
async function loadTrialUsedBytes(uid) {
  const candidates = [
    `usage/${uid}/usedBytes`,
    `users/${uid}/Usage/usedBytes`,
    `users/${uid}/License/usedBytes`,
  ];

  for (const path of candidates) {
    try {
      const snap = await get(ref(db, path));
      const val = snap.val();
      if (typeof val === "number" && Number.isFinite(val)) return val;
      if (typeof val === "string" && val && !Number.isNaN(Number(val))) return Number(val);
    } catch {
      // ignore and try next
    }
  }
  return 0;
}

/** summary: 契約状況UIをレンダリングする */
function renderLicense(license) {
  const plan = license?.plan || "trial";
  const limitBytes = license?.limitBytes ?? 50 * 1024 * 1024;
  const usedBytes = license?.usedBytes ?? 0;
  const cancelAtPeriodEnd = license?.cancelAtPeriodEnd === true;
  const cancelAt = license?.cancelAt ? new Date(license.cancelAt) : null;
  const cancelledAt = license?.cancelledAt ? new Date(license.cancelledAt) : null;
  const dataDeleteAt = license?.dataDeleteAt ? new Date(license.dataDeleteAt) : null;

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
      cancelStatus.textContent = `解約予約中 ${untilText}`;
    } else {
      cancelStatus.style.display = "none";
      cancelStatus.textContent = "";
    }
  }

  const cancelBtn = document.getElementById("cancel-subscription-btn");
  if (cancelBtn) cancelBtn.style.display = plan === "trial" ? "none" : "";

  // 現在契約中のプランは選択できないようにする（誤操作防止）
  // ボタンは「trial」は常に有効、それ以外は現在プランと一致する priceId を無効化する。
  try {
    const buttons = Array.from(document.querySelectorAll(".plan-btn"));
    // Price ID → planKey 逆引き（getCheckoutPriceIds が成功していれば data-price は現環境のID）
    const priceToPlanKey = new Map();
    buttons.forEach((b) => {
      const priceId = b.dataset.price;
      const label = (b.closest(".plan-card")?.querySelector("h3")?.textContent || "").trim();
      if (!priceId) return;
      // 表示名から planKey へ寄せる（最低限）
      const key =
        label === "ライト"
          ? "lite"
          : label === "スタンダード"
            ? "standard"
            : label === "プロ"
              ? "pro"
              : label === "従量課金"
                ? "ondemand"
                : null;
      if (key) priceToPlanKey.set(priceId, key);
    });

    buttons.forEach((b) => {
      const priceId = b.dataset.price;
      const key = priceId ? priceToPlanKey.get(priceId) : null;
      const isCurrent = plan !== "trial" && key && key === plan;
      b.disabled = !!isCurrent;
      b.title = isCurrent ? "現在契約中のプランです" : "";
    });
  } catch {
    // ignore
  }

  const ondemandStatus = document.getElementById("ondemand-status");
  if (ondemandStatus) {
    const until = license?.ondemandActiveUntil;
    if (until) {
      const d = new Date(until);
      const active = Number.isFinite(d.getTime()) && d.getTime() > Date.now();
      ondemandStatus.style.display = "block";
      ondemandStatus.textContent = active
        ? `従量課金: 有効（${d.toLocaleDateString("ja-JP")}まで）`
        : "従量課金: 期限切れ";
    } else {
      ondemandStatus.style.display = "block";
      ondemandStatus.textContent = "従量課金: 無効";
    }
  }
}

/** summary: RTDB のライセンス情報を監視し、許可されるパスへフォールバックする */
function watchLicense(uid, onLicense, onError) {
  // ルールで許可されやすい user 配下を優先（WPF と同じ方針）
  const userScopedRef = ref(db, `users/${uid}/License`);
  let unsubscribeRoot = null;

  const ensureRootListener = () => {
    if (unsubscribeRoot) return;
    const rootRef = ref(db, `licenses/${uid}`);
    unsubscribeRoot = onValue(
      rootRef,
      (snap) => {
        onLicense(snap.exists() ? snap.val() : null);
      },
      (err) => {
        if (onError) onError(err);
      }
    );
  };

  const unsubscribeUserScoped = onValue(
    userScopedRef,
    (snap) => {
      if (snap.exists()) {
        onLicense(snap.val());
        return;
      }
      // user 配下に無ければ旧スキーマ(root)を試す
      ensureRootListener();
    },
    (err) => {
      // user 配下が拒否/不在の環境向けに root も試しつつ、エラーは表示する
      ensureRootListener();
      if (onError) onError(err);
    }
  );

  return () => {
    try {
      unsubscribeUserScoped?.();
    } finally {
      unsubscribeRoot?.();
      unsubscribeRoot = null;
    }
  };
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

    // サインアップ直後は、Functions側の初期書き込み待ちのためリトライで吸収する
    loadLicenseWithRetryAfterSignup(user.uid).then((res) => {
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

// 従量課金プランは plan-btn（Checkout）経由で選択する
