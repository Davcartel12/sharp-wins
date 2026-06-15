/* ═══════════════════════════════════════════════════════════
   auth.js — sign-in modal + auth flow for the SPA
   Ported verbatim in behavior from home.html. Uses window.SW.
═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Where to go after a successful sign-in (set when a guarded action is attempted)
  window.SW_PENDING_NAV = null;

  function $(id) { return document.getElementById(id); }

  window.showStep = function (step) {
    $("stepEmail").style.display = step === "email" ? "block" : "none";
    $("stepCode").style.display = step === "code" ? "block" : "none";
    if (step === "email") setTimeout(function () { var e = $("modalEmail"); if (e) e.focus(); }, 50);
    if (step === "code") setTimeout(function () { var e = $("modalPassword"); if (e) e.focus(); }, 50);
  };

  window.openSignInModal = function () {
    $("signInModal").classList.add("show");
    showStep("email");
    clearError("emailError"); clearError("codeError");
  };
  window.closeSignInModal = function () {
    $("signInModal").classList.remove("show");
    window.SW_PENDING_NAV = null;
  };

  function clearError(id) { var el = $(id); if (el) { el.textContent = ""; el.classList.remove("show"); } }
  function showError(id, msg, green) {
    var el = $(id); if (!el) return;
    el.textContent = msg; el.style.color = green ? "#4ade80" : "#ff6b6b"; el.classList.add("show");
  }

  window.doEmailContinue = function () {
    var email = $("modalEmail").value.trim();
    if (!email || !/\S+@\S+\.\S+/.test(email)) { showError("emailError", "Please enter a valid email address."); return; }
    $("codeEmailDisplay").textContent = email;
    clearError("codeError");
    $("modalPassword").value = "";
    showStep("code");
  };

  window.togglePw = function () {
    var inp = $("modalPassword"), icon = $("pwEyeIcon");
    var show = inp.type === "password";
    inp.type = show ? "text" : "password";
    icon.className = show ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";
  };

  async function ensureProfileAfterAuth() {
    try {
      var user = SW.auth.currentUser;
      if (!user) return;
      var ref = SW.db.collection("users").doc(user.uid);
      var snap = await ref.get();
      if (!snap.exists) {
        var name = user.displayName || (user.email ? user.email.split("@")[0] : "Player");
        await ref.set({
          uid: user.uid, displayName: name, displayNameLower: name.toLowerCase(),
          balance: 100, demo: true, wins: 0, losses: 0, totalWinnings: 0,
          photoURL: "", friends: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    } catch (e) { console.warn("ensureProfile failed", e.message); }
  }

  function afterSignIn() {
    closeSignInModal();
    if (window.SW_PENDING_NAV) { var p = window.SW_PENDING_NAV; window.SW_PENDING_NAV = null; SW_NAV(p); }
  }

  window.doSignIn = async function () {
    var email = $("modalEmail").value.trim();
    var pass = $("modalPassword").value;
    if (!pass) { showError("codeError", "Please enter your password."); return; }
    if (pass.length < 6) { showError("codeError", "Password must be at least 6 characters."); return; }
    var btn = $("verifyCodeBtn");
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Please wait…';
    try {
      try {
        await SW.auth.signInWithEmailAndPassword(email, pass);
      } catch (inner) {
        if (["auth/user-not-found", "auth/invalid-credential", "auth/wrong-password"].indexOf(inner.code) >= 0) {
          try {
            await SW.auth.createUserWithEmailAndPassword(email, pass);
            await ensureProfileAfterAuth();
          } catch (regErr) {
            if (regErr.code === "auth/email-already-in-use") throw inner;
            throw regErr;
          }
        } else { throw inner; }
      }
      await ensureProfileAfterAuth();
      await SW.refreshProfile();
      afterSignIn();
    } catch (e) {
      var msg =
        e.code === "auth/wrong-password" ? "Incorrect password. Try again." :
        e.code === "auth/invalid-credential" ? "Incorrect password. Try again." :
        e.code === "auth/user-not-found" ? "No account found. Check your email." :
        e.code === "auth/too-many-requests" ? "Too many attempts. Please try later." :
        e.code === "auth/invalid-email" ? "Invalid email address." :
        e.code === "auth/weak-password" ? "Password must be at least 6 characters." :
        e.code === "auth/email-already-in-use" ? "Account exists. Check your password." :
        e.code === "auth/network-request-failed" ? "Network error. Check your connection." :
        "Sign-in failed. Please try again.";
      showError("codeError", msg);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
    }
  };

  window.doForgotPassword = async function () {
    var email = $("modalEmail").value.trim();
    if (!email) { showStep("email"); showError("emailError", "Enter your email first."); return; }
    try {
      await SW.auth.sendPasswordResetEmail(email);
      showError("codeError", "✓ Reset email sent! Check your inbox.", true);
    } catch (e) { showError("codeError", "Could not send reset email. Try again."); }
  };

  window.doGoogleSignIn = async function () {
    var btn = document.querySelector(".social-btn");
    if (btn) { btn.disabled = true; btn.style.opacity = "0.6"; }
    try {
      var provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      var result = await SW.auth.signInWithPopup(provider);
      if (result.user) {
        await ensureProfileAfterAuth();
        await SW.refreshProfile();
        afterSignIn();
      }
    } catch (e) {
      if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].indexOf(e.code) < 0) {
        var msg = e.code === "auth/unauthorized-domain"
          ? '⚠ Add "' + window.location.hostname + '" to Firebase Authorized Domains.'
          : e.code === "auth/popup-blocked"
          ? "⚠ Popup blocked. Allow popups for this site."
          : "Google sign-in failed: " + (e.message || e.code);
        showError("emailError", msg);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = ""; }
    }
  };

  // Guard: run an action only if signed in; else open modal and remember intent.
  window.SW_GUARD = function (navTarget) {
    if (SW.user) return true;
    if (navTarget) window.SW_PENDING_NAV = navTarget;
    openSignInModal();
    return false;
  };

  // Toast helper (ported)
  window.showToast = function (msg) {
    var t = document.getElementById("sw-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "sw-toast";
      t.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%) translateY(20px);background:#1a1a22;border:1px solid rgba(255,255,255,0.12);color:#e9f6ff;padding:12px 20px;border-radius:14px;font-size:13px;font-weight:700;z-index:999999;opacity:0;transition:all 0.25s;max-width:90vw;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.5);";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1"; t.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(t._timer);
    t._timer = setTimeout(function () {
      t.style.opacity = "0"; t.style.transform = "translateX(-50%) translateY(20px)";
    }, 3500);
  };

  // Wire modal dismiss + Enter keys once DOM is ready
  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.getElementById("signInModal");
    if (modal) modal.addEventListener("click", function (e) { if (e.target === this) closeSignInModal(); });
    var em = document.getElementById("modalEmail");
    if (em) em.addEventListener("keydown", function (e) { if (e.key === "Enter") doEmailContinue(); });
    var pw = document.getElementById("modalPassword");
    if (pw) pw.addEventListener("keydown", function (e) { if (e.key === "Enter") doSignIn(); });
  });
})();
