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

function renderLicense(license) {
  const plan = license?.plan || "trial";
  const limitBytes = license?.limitBytes ?? 50 * 1024 * 1024;
  const usedBytes = license?.usedBytes ?? 0;

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
  document.getElementById("renewed-at-value").textContent = renewedAt
    ? new Date(renewedAt).toLocaleDateString("ja-JP")
    : "---";
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    showSection("mypage");
    showPaymentMessages();

    const licenseRef = ref(db, `licenses/${user.uid}`);
    onValue(licenseRef, (snap) => renderLicense(snap.val()));
  } else {
    showSection("auth");
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
    await createUserWithEmailAndPassword(auth, email, password);
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
        alert("決済ページの取得に失敗しました");
      }
    } catch (err) {
      alert(err.message || "エラーが発生しました");
    } finally {
      btn.disabled = false;
    }
  });
});

document.getElementById("logout-btn")?.addEventListener("click", async () => {
  await signOut(auth);
});

/**
 * 解約（サブスクリプション停止）のために Stripe Customer Portal を開く
 */
async function openCancelPortal(buttonEl) {
  buttonEl.disabled = true;
  try {
    const user = auth.currentUser;
    if (!user) {
      alert("ログインが必要です");
      return;
    }

    const createPortal = httpsCallable(functions, "createBillingPortalSession");
    const { data } = await createPortal({});
    if (data?.url) {
      location.href = data.url;
    } else {
      alert("解約ページの取得に失敗しました");
    }
  } catch (err) {
    alert(err.message || "エラーが発生しました");
  } finally {
    buttonEl.disabled = false;
  }
}

document.getElementById("cancel-subscription-btn")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!btn) return;
  await openCancelPortal(btn);
});

document.getElementById("delete-account-btn")?.addEventListener("click", () => {
  document.getElementById("delete-confirm").style.display = "block";
});

document.getElementById("delete-cancel")?.addEventListener("click", () => {
  document.getElementById("delete-confirm").style.display = "none";
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
    alert("パスワードを入力してください");
    return;
  }

  const executeBtn = document.getElementById("delete-execute");
  executeBtn.disabled = true;
  try {
    const credential = EmailAuthProvider.credential(user.email, password);
    await reauthenticateWithCredential(user, credential);

    const deleteAccountFn = httpsCallable(functions, "deleteAccount");
    await deleteAccountFn();
    await signOut(auth);
    document.getElementById("delete-confirm").style.display = "none";
  } catch (err) {
    alert(err.message || "削除に失敗しました");
  } finally {
    executeBtn.disabled = false;
  }
});
