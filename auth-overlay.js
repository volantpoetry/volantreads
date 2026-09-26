/* VolantAuthOverlay — in-page Login / Signup modal.
 * Replaces cross-page redirects to universal-login.html / universal-signup.html.
 * Works on any Volant page: lazy-loads Firebase, reuses the page's existing app
 * when present (so the host page's onAuthStateChanged fires on login), and
 * intercepts links that point at the auth pages.
 * Includes a reCAPTCHA gate (same sitekey as the standalone auth pages) to
 * prevent bots; the submit button stays disabled until verification passes.
 */
(function () {
  if (window.VolantAuth) return;

  var CONFIG = {
    apiKey: "AIzaSyC4DHI8aBVY4JjTvJ-r-TGIDPsewtEWxzU",
    authDomain: "silent-depth.firebaseapp.com",
    projectId: "silent-depth",
    storageBucket: "silent-depth.firebasestorage.app",
    messagingSenderId: "78008755450",
    appId: "1:78008755450:web:3fd0f0f298a08820935543",
    measurementId: "G-WSWDCB7KD8"
  };

  var RECAPTCHA_SITEKEY = "6LfEe3wtAAAAACMvQc1vCwhgMtwvrH562PtKuXTU";

  var PLATFORM_NAMES = { poetry: "Volant Poetry", reads: "Volant Reads", foundry: "Volant Foundry" };
  var PLATFORM_BADGE = { poetry: "poetry", reads: "reads", foundry: "foundry" };

  var firebase = null;
  var current = { mode: "login", platform: "poetry", redirect: null };
  var elapsed = null;
  var busy = false;

  var recaptchaRequested = false;
  var recaptchaVerified = false;
  var recaptchaId = null;
  var recaptchaObserver = null;

  function authBase() {
    return /\/store1?\//.test(window.location.pathname) ? "../shared/" : "";
  }

  async function ensureFirebase() {
    if (firebase) return firebase;
    var fapp = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
    var fauth = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    var fdb = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    var app;
    try { app = fapp.getApp(); } catch (e) { app = fapp.initializeApp(CONFIG); }
    firebase = { app: app, auth: fauth.getAuth(app), db: fdb.getFirestore(app), fapp: fapp, fauth: fauth, fdb: fdb };
    return firebase;
  }

  function buildOverlay() {
    if (elapsed) return;
    elapsed = document.createElement("div");
    elapsed.className = "va-overlay";
    elapsed.setAttribute("role", "dialog");
    elapsed.setAttribute("aria-modal", "true");
    elapsed.innerHTML =
      '<div class="va-backdrop" data-va-close></div>' +
      '<div class="va-card">' +
      '<button type="button" class="va-close" data-va-close aria-label="Close">&times;</button>' +
      '<div class="va-badge">Volant Accounts</div>' +
      '<div class="va-head">' +
      '<h2 class="va-title">Welcome back</h2>' +
      '<p class="va-subtitle">Sign in to your account</p>' +
      '</div>' +
      '<button type="button" class="va-google" data-va-google>' +
      '<i class="fab fa-google"></i><span>Continue with Google</span>' +
      '</button>' +
      '<div class="va-or"><span>or continue with email</span></div>' +
      '<form class="va-form" novalidate>' +
      '<label for="va-email">Email</label>' +
      '<input type="email" id="va-email" class="va-input" placeholder="you@example.com" autocomplete="email">' +
      '<label for="va-password" class="va-pass-label">Password</label>' +
      '<div class="va-passwrap">' +
      '<input type="password" id="va-password" class="va-input" placeholder="Enter password" autocomplete="current-password">' +
      '<span class="va-eye" data-va-eye role="button" tabindex="0" aria-label="Show password"><i class="far fa-eye"></i></span>' +
      '</div>' +
      '<div class="va-recaptcha"><div class="g-recaptcha"></div></div>' +
      '<button type="submit" class="va-submit" data-va-submit disabled>' +
      '<span class="va-spinner"></span><span class="va-submit-text">Sign In</span>' +
      '</button>' +
      '</form>' +
      '<div class="va-status"></div>' +
      '<div class="va-alt">' +
      '<span class="va-alt-text">Don\'t have an account? </span><a href="#" data-va-switch>Sign up</a>' +
      '</div>' +
      '<div class="va-links">' +
      '<a href="#" data-va-reset>Forgot password?</a>' +
      '</div>' +
      '</div>' +
      '</div>';

    var style = document.createElement("style");
    style.textContent =
      '.va-overlay{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;padding:1rem;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;}' +
      '.va-overlay *{box-sizing:border-box;}' +
      '.va-overlay.va-open{display:flex;}' +
      '.va-backdrop{position:absolute;inset:0;background:rgba(15,12,20,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);}' +
      '.va-card{position:relative;width:100%;max-width:440px;max-height:92vh;overflow:auto;background:#fff;border-radius:24px;padding:1.7rem 1.8rem 1.5rem;box-shadow:0 30px 70px -20px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.35);}' +
      '.va-close{position:absolute;top:10px;right:14px;border:none;background:none;font-size:1.6rem;line-height:1;color:#9a94af;cursor:pointer;padding:4px 8px;border-radius:20px;}' +
      '.va-close:hover{background:#f5f3fa;color:#4b2aad;}' +
      '.va-badge{display:inline-block;padding:0.35rem 1rem;border-radius:60px;font-size:0.72rem;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;background:#4b2aad;color:#fff;margin-bottom:0.8rem;}' +
      '.va-badge.va-reads{background:linear-gradient(135deg,#d4a574,#c9944d);}.va-badge.va-foundry{background:linear-gradient(135deg,#2c3e50,#4a627a);}' +
      '.va-title{margin:0;font-size:1.7rem;font-weight:700;letter-spacing:-0.02em;color:#1d1a2b;}' +
      '.va-subtitle{color:#6b677a;font-size:0.9rem;margin:0.15rem 0 1.3rem;}' +
      '.va-google{width:100%;padding:0.9rem;border:2px solid #e4e0ed;border-radius:40px;background:#fff;font-weight:600;font-size:0.95rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;color:#1d1a2b;font-family:inherit;position:relative;box-shadow:0 2px 8px rgba(0,0,0,0.06);}' +
      '.va-google::before{content:\'\';position:absolute;inset:-2px;border-radius:42px;padding:2px;background:linear-gradient(135deg,#4285f4,#ea4335,#fbbc05,#34a853);-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;opacity:1;transition:opacity 0.3s ease;pointer-events:none;}' +
      '.va-google i{font-size:1.2rem;color:#4285f4;background:#fff;border-radius:50%;padding:2px;}' +
      '.va-google:hover:not(:disabled)::before{opacity:0.4;}' +
      '.va-google:hover:not(:disabled){background:#f8f7fc;transform:translateY(-2px);box-shadow:0 8px 24px rgba(66,133,244,0.2);}' +
      '.va-google:active:not(:disabled){transform:scale(0.98);}' +
      '.va-google:disabled{opacity:0.6;cursor:not-allowed;transform:none!important;}' +
      '.va-google:disabled::before{opacity:0.3;}' +
      '.va-or{text-align:center;margin:0.9rem 0 0.3rem;color:#bfbad0;font-size:0.78rem;letter-spacing:0.3px;}' +
      '.va-form label{display:block;font-size:0.82rem;font-weight:600;color:#2b263b;margin:0.9rem 0 0.3rem;}' +
      '.va-input{width:100%;padding:0.82rem 1rem;border:1.5px solid #e4e0ed;border-radius:16px;font-size:0.92rem;background:rgba(255,255,255,0.6);color:#1d1a2b;font-family:inherit;outline:none;}' +
      '.va-input:focus{border-color:#4b2aad;box-shadow:0 0 0 4px rgba(75,42,173,0.08);background:#fff;}' +
      '.va-passwrap{position:relative;}' +
      '.va-eye{position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;color:#9a94af;padding:4px 6px;}' +
      '.va-eye:hover{color:#4b2aad;}' +
      '.va-recaptcha{display:flex;justify-content:center;margin:1.1rem 0 0.4rem;position:relative;z-index:3;}' +
      '.va-recaptcha .g-recaptcha{position:relative;z-index:3;}' +
      '.va-recaptcha iframe[src*="recaptcha"]{transform:none!important;}' +
      '.va-submit{width:100%;padding:0.9rem;margin-top:0.9rem;border:none;border-radius:40px;background:#4b2aad;color:#fff;font-weight:600;font-size:0.98rem;cursor:pointer;box-shadow:0 8px 18px rgba(75,42,173,0.2);display:flex;align-items:center;justify-content:center;gap:10px;font-family:inherit;}' +
      '.va-submit:hover:not(:disabled){background:#3a1f85;}' +
      '.va-submit:disabled{opacity:0.7;cursor:not-allowed;box-shadow:none;}' +
      '.va-spinner{display:none;border:2.5px solid rgba(255,255,255,0.25);border-top:2.5px solid #fff;border-radius:50%;width:18px;height:18px;animation:va-spin 0.8s linear infinite;}' +
      '@keyframes va-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}' +
      '.va-submit.va-loading .va-spinner{display:inline-block;}' +
      '.va-submit.va-loading .va-submit-text{display:none;}' +
      '.va-status{margin-top:0.9rem;padding:0.7rem 0.9rem;border-radius:16px;font-size:0.86rem;display:none;font-weight:500;}' +
      '.va-status.va-show{display:block;}' +
      '.va-status.va-ok{background:#eaf6ed;color:#1f6b44;border:1px solid #b7dfc9;}' +
      '.va-status.va-err{background:#fdeded;color:#b33c3c;border:1px solid #f5d0d0;}' +
      '.va-status.va-info{background:#e8edfd;color:#2a4a9e;border:1px solid #c8d4f5;}' +
      '.va-alt{background:rgba(245,242,252,0.5);padding:0.85rem;border-radius:24px;margin-top:1.4rem;text-align:center;font-size:0.88rem;color:#2b263b;}' +
      '.va-alt a,.va-links a{color:#4b2aad;font-weight:600;text-decoration:none;}' +
      '.va-links{text-align:center;margin-top:0.9rem;font-size:0.84rem;}' +
      '.va-links a{color:#6b677a;font-weight:500;}' +
      '.va-links a:hover{color:#4b2aad;}' +
      '.va-card ::-webkit-scrollbar{width:8px;}' +
      '@media (max-width:520px){' +
      '.va-card{padding:1.3rem 1.2rem 1.25rem;border-radius:22px;}' +
      '.va-title{font-size:1.35rem;}' +
      '.va-subtitle{font-size:0.85rem;margin-bottom:1.15rem;}' +
      '.va-input{font-size:16px;padding:0.78rem 0.95rem;}' +
      '.va-google{padding:0.8rem;font-size:0.92rem;}' +
      '.va-recaptcha{margin:1rem 0 0.3rem;}' +
      '.va-close{top:8px;right:10px;}' +
      '.va-alt{margin-top:1.2rem;padding:0.8rem;}' +
      '}' +
      '@media (max-width:360px){' +
      '.va-form label{font-size:0.8rem;}' +
      '}';

    var host = document.head || document.documentElement;
    host.appendChild(style);
    document.body.appendChild(elapsed);
    bindEvents();
  }

  function q(sel) { return elapsed.querySelector(sel); }

  // ---------- reCAPTCHA ----------

  function setRecaptchaGate(verified) {
    recaptchaVerified = !!verified;
    var btn = q("[data-va-submit]");
    if (btn) btn.disabled = !verified;
  }

  function onRecaptchaSuccess() {
    setRecaptchaGate(true);
  }
  function onRecaptchaExpired() {
    setRecaptchaGate(false);
    var s = q(".va-status");
    if (s) { s.textContent = "reCAPTCHA expired. Please verify again."; s.className = "va-status va-show va-info"; }
  }

  function renderRecaptcha() {
    if (!elapsed || !elapsed.classList.contains("va-open")) return;
    if (!window.grecaptcha || typeof grecaptcha.render !== "function") return;
    var container = q(".va-recaptcha .g-recaptcha");
    if (!container) return;
    if (recaptchaId !== null) {
      try { grecaptcha.reset(recaptchaId); } catch (e) {}
      setRecaptchaGate(false);
      return;
    }
    try {
      recaptchaId = grecaptcha.render(container, {
        sitekey: RECAPTCHA_SITEKEY,
        callback: onRecaptchaSuccess,
        "expired-callback": onRecaptchaExpired,
        "error-callback": onRecaptchaExpired
      });
      setRecaptchaGate(false);
    } catch (e) {}
  }

  function waitRecaptcha() {
    var base = 0;
    var iv = setInterval(function () {
      base += 200;
      if (window.grecaptcha && typeof grecaptcha.render === "function") {
        clearInterval(iv);
        recaptchaRequested = false;
        renderRecaptcha();
      } else if (base > 10000) {
        clearInterval(iv);
        recaptchaRequested = false;
      }
    }, 200);
  }

  function ensureRecaptcha() {
    if (!recaptchaRequested) {
      if (window.grecaptcha && typeof grecaptcha.render === "function") {
        renderRecaptcha();
        return;
      }
      recaptchaRequested = true;
      var existing = document.querySelector('script[src*="/recaptcha/api.js"]');
      if (!existing) {
        var s = document.createElement("script");
        s.src = "https://www.google.com/recaptcha/api.js?render=explicit&onload=onVaRecaptchaLoad";
        s.async = true;
        s.defer = true;
        (document.head || document.documentElement).appendChild(s);
      }
      waitRecaptcha();
    }
  }

  function liftChallengeFrame(f) {
    if (f.__va_lifted) return;
    var st = f.style;
    f.__va_save = { pos: st.position, top: st.top, left: st.left, z: st.zIndex, tf: st.transform };
    st.setProperty("position", "fixed", "important");
    st.setProperty("top", "50%", "important");
    st.setProperty("left", "50%", "important");
    st.setProperty("transform", "translate(-50%,-50%)", "important");
    st.setProperty("z-index", "2147483647", "important");
    f.__va_lifted = true;
    if (elapsed && elapsed.contains(f)) {
      document.body.appendChild(f);
    }
  }

  function restoreLiftedFrames() {
    Array.prototype.forEach.call(document.querySelectorAll("iframe"), function (f) {
      if (f.__va_lifted && f.__va_save) {
        var st = f.style;
        var sv = f.__va_save;
        st.position = sv.pos;
        st.top = sv.top;
        st.left = sv.left;
        st.zIndex = sv.z;
        st.transform = sv.tf;
        delete f.__va_lifted;
        delete f.__va_save;
      }
    });
  }

  function handleRecaptchaNode(n) {
    if (!n || n.nodeType !== 1 || !n.matches || !n.matches('iframe[src*="recaptcha"]')) return;
    if (elapsed && !elapsed.contains(n)) {
      n.style.setProperty("z-index", "2147483647", "important");
    }
    window.requestAnimationFrame(function () {
      var h = n.offsetHeight || parseInt(n.style.height || "0", 10) || 0;
      if (h >= 200) liftChallengeFrame(n);
    });
  }

  function raiseRecaptchaFrames() {
    if (!elapsed) return;
    Array.prototype.slice.call(document.querySelectorAll('iframe[src*="recaptcha"]')).forEach(function (f) {
      if (!elapsed.contains(f)) {
        f.style.setProperty("z-index", "2147483647", "important");
      }
      var h = f.offsetHeight || parseInt(f.style.height || "0", 10) || 0;
      if (h >= 200) liftChallengeFrame(f);
    });
    var badge = document.querySelector(".grecaptcha-badge");
    if (badge) badge.style.visibility = "hidden";
  }

  function watchRecaptcha(start) {
    if (start) {
      if (recaptchaObserver) return;
      recaptchaObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            handleRecaptchaNode(n);
          });
        });
      });
      recaptchaObserver.observe(document.documentElement, { childList: true, subtree: true });
    } else if (recaptchaObserver) {
      recaptchaObserver.disconnect();
      recaptchaObserver = null;
    }
  }

  window.onVaRecaptchaLoad = function () {
    recaptchaRequested = false;
    renderRecaptcha();
  };

  // ---------- mode switching ----------

  function setMode(mode) {
    current.mode = mode === "signup" ? "signup" : "login";
    var login = current.mode === "login";
    q(".va-title").textContent = login ? "Welcome back" : "Create your account";
    q(".va-subtitle").textContent = login ? "Sign in to your account" : "Join Volant in under a minute";
    q(".va-submit-text").textContent = login ? "Sign In" : "Create Account";
    q(".va-alt-text").textContent = login ? "Don't have an account? " : "Already have an account? ";
    q("[data-va-switch]").textContent = login ? "Sign up" : "Sign in";
    q(".va-pass-label").textContent = login ? "Password" : "Create a password";
    q("#va-password").setAttribute("autocomplete", login ? "current-password" : "new-password");
    q("#va-password").placeholder = login ? "Enter password" : "At least 6 characters";
  }

  function switchMode() {
    setMode(current.mode === "login" ? "signup" : "login");
    var s = q(".va-status");
    s.className = "va-status";
    s.textContent = "";
    q("#va-password").value = "";
  }

  // ---------- events ----------

  function bindEvents() {
    elapsed.querySelectorAll("[data-va-close]").forEach(function (b) {
      b.addEventListener("click", close);
    });
    q("[data-va-switch]").addEventListener("click", function (e) { e.preventDefault(); switchMode(); });
    q("[data-va-reset]").addEventListener("click", function (e) {
      e.preventDefault();
      var params = new URLSearchParams();
      params.append("platform", current.platform);
      if (current.redirect) params.append("redirect", current.redirect);
      window.location.href = authBase() + "users-reset.html?" + params.toString();
    });
    var eye = q("[data-va-eye]");
    eye.addEventListener("click", toggleEye);
    eye.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleEye(); }
    });
    q(".va-form").addEventListener("submit", onSubmit);
    q("[data-va-google]").addEventListener("click", onGoogle);
  }

  function toggleEye() {
    var p = q("#va-password");
    var show = p.type === "password";
    p.type = show ? "text" : "password";
    q("[data-va-eye]").innerHTML = show ? '<i class="fas fa-eye-slash"></i>' : '<i class="far fa-eye"></i>';
  }

  function normalizeRedirect(raw) {
    if (!raw) return null;
    var decoded = String(raw);
    try { decoded = decodeURIComponent(decoded); } catch (e) {}
    try {
      var u = new URL(decoded, window.location.origin);
      return u.pathname + u.search;
    } catch (e) {
      return decoded.charAt(0) === "/" ? decoded : "/" + decoded;
    }
  }

  function openOverlay(mode, opts) {
    if (!elapsed) buildOverlay();
    opts = opts || {};
    current.mode = mode === "signup" ? "signup" : "login";
    current.platform = opts.platform || defaultPlatform();
    current.redirect = normalizeRedirect(opts.redirect);
    var badge = q(".va-badge");
    badge.textContent = PLATFORM_NAMES[current.platform] || "Volant Accounts";
    badge.className = "va-badge" + (PLATFORM_BADGE[current.platform] ? " va-" + PLATFORM_BADGE[current.platform] : "");
    setMode(current.mode);
    var s = q(".va-status");
    s.className = "va-status";
    s.textContent = "";
    q("#va-email").value = "";
    q("#va-password").value = "";
    setRecaptchaGate(false);
    setBusy(false);
    elapsed.classList.add("va-open");
    document.body.style.overflow = "hidden";
    raiseRecaptchaFrames();
    watchRecaptcha(true);
    ensureRecaptcha();
    setTimeout(function () { q("#va-email").focus(); }, 80);
  }

  function close() {
    if (!elapsed) return;
    elapsed.classList.remove("va-open");
    document.body.style.overflow = "";
    watchRecaptcha(false);
    restoreLiftedFrames();
    var badge = document.querySelector(".grecaptcha-badge");
    if (badge) badge.style.visibility = "";
    q("#va-password").value = "";
  }

  function defaultPlatform() {
    return /\/store1?\//.test(window.location.pathname) ? "reads" : "poetry";
  }

  function extractParams(href) {
    var m = String(href).split("?");
    var params = new URLSearchParams(m[1] || "");
    var platform = params.get("platform") || null;
    var redirect = params.get("redirect") || null;
    if (redirect) { try { redirect = decodeURIComponent(redirect); } catch (e) {} }
    return { platform: platform, redirect: redirect };
  }

  function dispatchAuth(mode, user) {
    try {
      window.dispatchEvent(new CustomEvent("volant:auth", { detail: { mode: mode, user: user } }));
    } catch (e) {}
  }

  function setStatus(msg, type) {
    var s = q(".va-status");
    s.textContent = msg;
    s.className = "va-status va-show" + (type ? " va-" + type : "");
  }

  function setBusy(on) {
    busy = on;
    q("[data-va-submit]").disabled = on || !recaptchaVerified;
    q("[data-va-google]").disabled = on;
    q("[data-va-submit]").classList.toggle("va-loading", on);
  }

  function finish(mode) {
    var s = q(".va-status");
    s.className = "va-status";
    s.textContent = "";
    close();
    if (current.redirect) {
      setTimeout(function () { window.location.href = current.redirect; }, 500);
    } else {
      dispatchAuth(mode, null);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (!recaptchaVerified) {
      setStatus("Please complete the reCAPTCHA verification.", "info");
      return;
    }
    await ensureFirebase();
    var fb = firebase;
    var fauth = fb.fauth;
    var fdb = fb.fdb;
    var auth = fb.auth;
    var db = fb.db;
    var emailInput = q("#va-email").value.trim();
    var passInput = q("#va-password").value;
    if (!emailInput) { setStatus("Please enter your email or username.", "err"); return; }
    if (!passInput) { setStatus("Please enter your password.", "err"); return; }

    setBusy(true);
    try {
      if (current.mode === "login") {
        var email = emailInput;
        if (!emailInput.includes("@")) {
          var uq = fdb.query(fdb.collection(db, "users"), fdb.where("username", "==", emailInput));
          var us = await fdb.getDocs(uq);
          if (us.empty) { setStatus("Username or email not found.", "err"); setBusy(false); return; }
          email = us.docs[0].data().email;
        }
        var cred = await fauth.signInWithEmailAndPassword(auth, email, passInput);
        var user = cred.user;
        for (var i = 0; i < 3; i++) {
          await user.reload();
          if (user.emailVerified) break;
          await new Promise(function (r) { setTimeout(r, 500); });
        }
        if (!user.emailVerified) {
          await fauth.signOut(auth);
          localStorage.setItem("pendingVerificationEmail", user.email);
          var p = new URLSearchParams();
          p.append("email", user.email);
          p.append("platform", current.platform);
          if (current.redirect) p.append("redirect", current.redirect);
          window.location.href = authBase() + "verify-email.html?" + p.toString();
          return;
        }
        setStatus("Login successful!", "ok");
        dispatchAuth("login", user);
        finish("login");
      } else {
        if (passInput.length < 6) { setStatus("Password must be at least 6 characters.", "err"); setBusy(false); return; }
        var identifier = emailInput;
        var eq = fdb.query(fdb.collection(db, "users"), fdb.where("email", "==", identifier));
        var es = await fdb.getDocs(eq);
        if (!es.empty) { setStatus("Email already registered.", "err"); setBusy(false); return; }
        var base = identifier.split("@")[0];
        if (!base || base.length < 3) base = "user";
        var username = await generateUniqueUsername(fb, base);
        var accountEmail = identifier;
        var c = await fauth.createUserWithEmailAndPassword(auth, accountEmail, passInput);
        var nu = c.user;
        await fauth.sendEmailVerification(nu);
        await fdb.setDoc(fdb.doc(db, "users", nu.uid), {
          username: username,
          email: accountEmail,
          displayName: username,
          photoURL: "",
          createdAt: fdb.serverTimestamp(),
          platform: current.platform,
          emailVerified: false,
          authProvider: "email",
          lastLogin: fdb.serverTimestamp()
        });
        await fauth.signOut(auth);
        setStatus("Account created! Verification email sent. Redirecting…", "ok");
        var vp = new URLSearchParams();
        vp.append("email", accountEmail);
        vp.append("platform", current.platform);
        if (current.redirect) vp.append("redirect", current.redirect);
        setTimeout(function () { window.location.href = authBase() + "verify-email.html?" + vp.toString(); }, 1600);
      }
    } catch (err) {
      var msg = (err && err.message) || "Something went wrong.";
      if (err && err.code === "auth/user-not-found") msg = "Username or email not found.";
      else if (err && err.code === "auth/wrong-password") msg = "Incorrect password.";
      else if (err && err.code === "auth/too-many-requests") msg = "Too many failed attempts. Try again later.";
      else if (err && err.code === "auth/email-already-in-use") msg = "Email already registered.";
      else if (err && err.code === "auth/weak-password") msg = "Password should be at least 6 characters.";
      else if (err && err.code === "auth/invalid-email") msg = "Invalid email address.";
      setStatus(msg, "err");
      setBusy(false);
    }
  }

  async function onGoogle() {
    if (busy) return;
    await ensureFirebase();
    var fb = firebase;
    var fauth = fb.fauth;
    var fdb = fb.fdb;
    var auth = fb.auth;
    var db = fb.db;
    setBusy(true);
    setStatus("Connecting to Google…", "info");
    try {
      var provider = new fauth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      var result;
      try {
        result = await fauth.signInWithPopup(auth, provider);
      } catch (pe) {
        if (pe.code === "auth/popup-blocked" || pe.code === "auth/popup-closed-by-user" || pe.code === "auth/cancelled-popup-request") {
          sessionStorage.setItem("vaGoogleRedirectPending", "1");
          await fauth.signInWithRedirect(auth, provider);
          return;
        }
        throw pe;
      }
      var user = result.user;
      var ref = fdb.doc(db, "users", user.uid);
      var doc = await fdb.getDoc(ref);
      if (!doc.exists()) {
        var uname = await generateUniqueUsername(fb, user.displayName || user.email || "user");
        await fdb.setDoc(ref, {
          username: uname,
          email: user.email,
          displayName: user.displayName || uname,
          photoURL: user.photoURL || "",
          createdAt: fdb.serverTimestamp(),
          platform: current.platform,
          emailVerified: user.emailVerified || false,
          authProvider: "google",
          lastLogin: fdb.serverTimestamp(),
          isVerified: true
        });
      } else {
        await fdb.updateDoc(ref, { lastLogin: fdb.serverTimestamp() });
      }
      setStatus("Welcome!", "ok");
      setBusy(false);
      dispatchAuth("login", user);
      finish("login");
    } catch (err) {
      var msg = "Google sign-in failed. Please try again.";
      if (err && err.code === "auth/account-exists-with-different-credential") msg = "An account already exists with this email. Sign in with your password.";
      if ((err && err.code === "auth/cancelled-popup-request") || (err && err.code === "auth/popup-closed-by-user")) msg = "Sign-in cancelled.";
      setStatus(msg, "err");
      setBusy(false);
    }
  }

  async function isUsernameTaken(fb, username) {
    if (!username || username.length < 3) return false;
    try {
      var qq = fb.fdb.query(fb.fdb.collection(fb.db, "users"), fb.fdb.where("username", "==", username));
      var snap = await fb.fdb.getDocs(qq);
      return !snap.empty;
    } catch (e) { return false; }
  }

  async function generateUniqueUsername(fb, baseName) {
    if (!baseName || baseName.length < 3) baseName = "user";
    var clean = String(baseName).replace(/\s/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "").substring(0, 11);
    if (!clean || clean.length < 3) clean = "user_" + Math.random().toString(36).substring(2, 6);
    if (!(await isUsernameTaken(fb, clean))) return clean;
    var counter = 1;
    while (counter <= 100) {
      var suffix = String(counter);
      var base = clean.substring(0, 11 - suffix.length);
      var cand = base + suffix;
      if (!(await isUsernameTaken(fb, cand))) return cand;
      counter++;
    }
    return clean + "_" + Date.now().toString(36);
  }

  function interceptClicks() {
    document.addEventListener("click", function (e) {
      var t = e.target;
      var link = t && t.closest ? t.closest('a[href*="universal-login"], a[href*="universal-signup"]') : null;
      if (!link) return;
      var href = link.getAttribute("href") || "";
      if (!/universal-(?:login|signup)\.html/i.test(href)) return;
      var mode = /signup/i.test(href) ? "signup" : "login";
      var p = extractParams(href);
      e.preventDefault();
      if (window.VolantAuth) {
        window.VolantAuth.open(mode, { platform: p.platform, redirect: p.redirect });
      }
    });
  }

  function handleRedirectPending() {
    var pending = sessionStorage.getItem("vaGoogleRedirectPending");
    if (!pending) return;
    sessionStorage.removeItem("vaGoogleRedirectPending");
    ensureFirebase().then(function (fb) {
      fb.fauth.onAuthStateChanged(fb.auth, function (user) {
        if (user) { dispatchAuth("login", user); close(); }
      });
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && elapsed && elapsed.classList.contains("va-open")) close();
  });

  interceptClicks();
  handleRedirectPending();

  window.VolantAuth = {
    open: openOverlay,
    close: close,
    mode: function () { return current.mode; }
  };
})();