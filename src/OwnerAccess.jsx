import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import QRCode from "qrcode";
import "./owner-access.css";

const MIN_PASSWORD = 14;
const MAX_PASSWORD = 128;
const emptyAction = () => {};

async function ownerRequest(
  path,
  { method = "GET", body, csrfToken, signal } = {},
) {
  const response = await fetch(`/api/owner${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  let result = {};
  if (response.status !== 204) {
    try {
      result = await response.json();
    } catch {
      throw new Error("Owner access could not be reached. Please try again.");
    }
  }
  if (!response.ok) {
    const message =
      typeof result.error === "string" ? result.error : result.error?.message;
    const error = new Error(
      message || "We could not complete that request. Please try again.",
    );
    error.status = response.status;
    error.code = result.code;
    throw error;
  }
  return result;
}

function takeActivationToken() {
  if (!location.hash.startsWith("#owner-setup?")) return "";
  const params = new URLSearchParams(
    location.hash.slice("#owner-setup?".length),
  );
  const token = params.get("token") || "";
  // The fragment never travels to the server and is removed before any further navigation.
  history.replaceState({}, "", `${location.pathname}${location.search}#owner`);
  return token.length <= 512 ? token : "";
}

function passwordProblem(password) {
  if (
    password.length < MIN_PASSWORD ||
    password.length > MAX_PASSWORD ||
    new TextEncoder().encode(password).length > 512
  ) {
    return "Choose a password of 14–128 characters, up to 512 bytes. A unique passphrase works well.";
  }
  return "";
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete = "current-password",
  newPassword = false,
  disabled = false,
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field-label owner-field" htmlFor={id}>
      {label}
      <span className="owner-password-field">
        <input
          id={id}
          name={id}
          className="text-input"
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          required
          disabled={disabled}
          minLength={newPassword ? MIN_PASSWORD : undefined}
          maxLength={MAX_PASSWORD}
          spellCheck={false}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
    </label>
  );
}

function CodeField({
  id,
  value,
  onChange,
  label = "Authenticator code",
  disabled = false,
}) {
  return (
    <label className="field-label owner-field" htmlFor={id}>
      {label}
      <input
        id={id}
        name={id}
        className="text-input owner-code-input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        value={value}
        onChange={(event) =>
          onChange(event.target.value.replace(/\D/g, "").slice(0, 6))
        }
        required
        disabled={disabled}
        placeholder="000000"
      />
    </label>
  );
}

function ErrorNotice({ message }) {
  return message ? (
    <p className="owner-error" role="alert">
      {message}
    </p>
  ) : null;
}

export function OwnerAccess({
  onAuthenticated = emptyAction,
  onBack = emptyAction,
  notify = emptyAction,
  activationToken,
  requireFreshLogin = false,
}) {
  const [setupToken, setSetupToken] = useState(
    () => activationToken || takeActivationToken(),
  );
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [enrollment, setEnrollment] = useState(null);
  const [qrImage, setQrImage] = useState("");
  const [recovery, setRecovery] = useState(null);
  const [savedCodes, setSavedCodes] = useState(false);
  const sessionCallback = useRef(onAuthenticated);
  sessionCallback.current = onAuthenticated;

  useEffect(() => {
    // Also scrub a provided activation fragment when the parent has already read it.
    if (location.hash.startsWith("#owner-setup?"))
      history.replaceState(
        {},
        "",
        `${location.pathname}${location.search}#owner`,
      );
    const controller = new AbortController();
    ownerRequest("/session", { signal: controller.signal })
      .then((result) => {
        setStatus(result);
        if (result.configured) setSetupToken("");
        if (result.authenticated && !requireFreshLogin)
          sessionCallback.current({
            owner: result.owner,
            csrfToken: result.csrfToken,
          });
      })
      .catch((requestError) => {
        if (requestError.name !== "AbortError") setError(requestError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!enrollment?.otpauthUrl) {
      setQrImage("");
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(enrollment.otpauthUrl, {
      width: 224,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#193c31", light: "#ffffff" },
    })
      .then((image) => {
        if (!cancelled) setQrImage(image);
      })
      .catch(() => {
        if (!cancelled) setQrImage("");
      });
    return () => {
      cancelled = true;
    };
  }, [enrollment?.otpauthUrl]);

  const setup = Boolean(
    status && !status.configured && status.setupAvailable && setupToken,
  );
  const canLogin = Boolean(status?.configured);

  const beginSetup = async (event) => {
    event.preventDefault();
    setError("");
    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(cleanUsername)) {
      setError(
        "Choose a username of 3–40 letters, numbers, dots, dashes or underscores, starting with a letter or number.",
      );
      return;
    }
    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    if (password !== confirmPassword) {
      setError("Your passwords do not match. Please enter them again.");
      return;
    }
    setBusy(true);
    try {
      const result = await ownerRequest("/setup/start", {
        method: "POST",
        body: { setupToken, username: cleanUsername, password },
      });
      setUsername(cleanUsername);
      setEnrollment(result);
      setPassword("");
      setConfirmPassword("");
      setCode("");
      setPhase("authenticator");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const completeSetup = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await ownerRequest("/setup/complete", {
        method: "POST",
        body: { flowToken: enrollment.flowToken, code },
      });
      setRecovery(result);
      setEnrollment(null);
      setSetupToken("");
      setCode("");
      setPhase("recovery");
    } catch (requestError) {
      setError(requestError.message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const login = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await ownerRequest("/login", {
        method: "POST",
        body: {
          username: username.trim().toLowerCase(),
          password,
          ...(useRecovery ? { recoveryCode: recoveryCode.trim() } : { code }),
        },
      });
      setPassword("");
      setCode("");
      setRecoveryCode("");
      notify("You’re securely signed in.");
      sessionCallback.current({
        owner: result.owner,
        csrfToken: result.csrfToken,
      });
    } catch (requestError) {
      setError(requestError.message);
      setCode("");
      setRecoveryCode("");
    } finally {
      setBusy(false);
    }
  };

  const downloadRecoveryCodes = () => {
    const contents = `LEAFIVO OWNER RECOVERY CODES\n\nOwner: ${recovery?.owner?.username || username}\n\n${(recovery?.recoveryCodes || []).join("\n")}\n\nEach code can be used once with your password if your authenticator is unavailable. Keep this file offline in a secure place. Never send these codes to support or post them online.\n`;
    const objectUrl = URL.createObjectURL(
      new Blob([contents], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "leafivo-owner-recovery-codes.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const enterStore = () => {
    if (!savedCodes || !recovery) return;
    const session = { owner: recovery.owner, csrfToken: recovery.csrfToken };
    setRecovery(null);
    notify("Your owner account is ready.");
    sessionCallback.current(session);
  };

  const step = phase === "authenticator" ? 2 : phase === "recovery" ? 3 : 1;
  return (
    <section className="owner-access">
      <button type="button" className="text-link owner-back" onClick={onBack}>
        <ArrowLeft size={16} />
        Back to the store
      </button>
      <div className="owner-access-layout">
        <aside className="owner-access-intro">
          <div className="owner-access-seal">
            <ShieldCheck size={28} strokeWidth={1.4} />
          </div>
          <span className="eyebrow">YOUR PRIVATE WORKSPACE</span>
          <h1>
            Your store.
            <br />
            <em>In good hands.</em>
          </h1>
          <p>
            A protected space for your products, your plans, and the work that
            comes next.
          </p>
          <ul>
            <li>
              <LockKeyhole size={17} />
              Password and authenticator protection
            </li>
            <li>
              <ShieldCheck size={17} />
              Private, expiring owner sessions
            </li>
            <li>
              <KeyRound size={17} />
              Recovery codes for a spare way in
            </li>
          </ul>
          <span className="owner-access-note">
            Leafivo will never ask you to share your password, authenticator
            code or recovery codes in a message.
          </span>
        </aside>
        <div className="owner-access-card studio-card">
          {loading ? (
            <div className="owner-loading" role="status">
              <LoaderCircle className="spin" size={26} />
              <span>Opening your private workspace…</span>
            </div>
          ) : phase === "recovery" && recovery ? (
            <>
              <span className="eyebrow">03 / KEEP A SPARE KEY</span>
              <h2>Save your recovery codes.</h2>
              <p className="owner-description">
                If you lose access to your authenticator, each code gives you
                one sign-in with your password. These codes are shown only once.
              </p>
              <div
                className="owner-recovery-codes"
                aria-label="Owner recovery codes"
              >
                {(recovery.recoveryCodes || []).map((item) => (
                  <code key={item}>{item}</code>
                ))}
              </div>
              <button
                className="button secondary full-width"
                type="button"
                onClick={downloadRecoveryCodes}
              >
                <Download size={17} />
                Download recovery codes
              </button>
              <label className="checkbox-label owner-saved-checkbox">
                <input
                  type="checkbox"
                  checked={savedCodes}
                  onChange={(event) => setSavedCodes(event.target.checked)}
                />
                I saved these codes somewhere private.
              </label>
              <button
                className="button primary full-width"
                type="button"
                onClick={enterStore}
                disabled={!savedCodes}
              >
                Open my store studio <ArrowRight size={17} />
              </button>
            </>
          ) : phase === "authenticator" && enrollment ? (
            <>
              <span className="eyebrow">02 / ADD YOUR AUTHENTICATOR</span>
              <h2>A second layer of protection.</h2>
              <p className="owner-description">
                Open an authenticator app, such as Google Authenticator or
                Microsoft Authenticator. Add an account, scan this code, then
                enter its six-digit code below. Keep this page open while you
                finish.
              </p>
              <div className="owner-qr">
                {qrImage ? (
                  <img
                    src={qrImage}
                    width="224"
                    height="224"
                    alt="Authenticator setup QR code"
                  />
                ) : (
                  <Smartphone size={35} strokeWidth={1.2} />
                )}
              </div>
              <details className="owner-manual-secret">
                <summary>Can’t scan? Enter a setup key instead.</summary>
                <span>Account: {username}</span>
                <code>{enrollment.secret}</code>
              </details>
              <form onSubmit={completeSetup}>
                <CodeField
                  id="owner-setup-code"
                  value={code}
                  onChange={setCode}
                  disabled={busy}
                />
                <ErrorNotice message={error} />
                <button
                  className="button primary full-width"
                  type="submit"
                  disabled={busy || code.length !== 6}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <ShieldCheck size={17} />
                  )}
                  Verify and protect my account
                </button>
              </form>
              <p className="owner-small-note">
                The setup window lasts ten minutes. If it expires, reopen your
                private setup link and start again.
              </p>
            </>
          ) : setup ? (
            <>
              <span className="eyebrow">01 / MAKE THIS SPACE YOURS</span>
              <h2>Create your owner login.</h2>
              <p className="owner-description">
                Choose a unique password. Next, you’ll connect an authenticator
                and save your recovery codes.
              </p>
              <ol
                className="owner-setup-steps"
                aria-label="Owner setup progress"
              >
                {["Your login", "Authenticator", "Recovery codes"].map(
                  (label, index) => (
                    <li
                      key={label}
                      aria-current={step === index + 1 ? "step" : undefined}
                    >
                      <span>{index + 1}</span>
                      {label}
                    </li>
                  ),
                )}
              </ol>
              <form onSubmit={beginSetup}>
                <label
                  className="field-label owner-field"
                  htmlFor="owner-new-username"
                >
                  Owner username
                  <input
                    className="text-input"
                    id="owner-new-username"
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}"
                    minLength={3}
                    maxLength={40}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
                <PasswordField
                  id="owner-new-password"
                  label="Create a password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  newPassword
                  disabled={busy}
                />
                <PasswordField
                  id="owner-confirm-password"
                  label="Confirm your password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  newPassword
                  disabled={busy}
                />
                <p className="owner-small-note">
                  Use 14–128 characters. Choose a password you do not use
                  anywhere else.
                </p>
                <ErrorNotice message={error} />
                <button
                  className="button primary full-width"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <ArrowRight size={17} />
                  )}
                  Continue to authenticator
                </button>
              </form>
            </>
          ) : canLogin ? (
            <>
              <span className="eyebrow">WELCOME BACK</span>
              <h2>Your private studio.</h2>
              <p className="owner-description">Sign in to manage your store.</p>
              <form onSubmit={login}>
                <label
                  className="field-label owner-field"
                  htmlFor="owner-login-username"
                >
                  Owner username
                  <input
                    className="text-input"
                    id="owner-login-username"
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={40}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
                <PasswordField
                  id="owner-login-password"
                  label="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                />
                {useRecovery ? (
                  <label
                    className="field-label owner-field"
                    htmlFor="owner-login-recovery"
                  >
                    Recovery code
                    <input
                      className="text-input owner-recovery-input"
                      id="owner-login-recovery"
                      name="recovery-code"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="none"
                      maxLength={128}
                      value={recoveryCode}
                      onChange={(event) => setRecoveryCode(event.target.value)}
                      required
                      disabled={busy}
                    />
                  </label>
                ) : (
                  <CodeField
                    id="owner-login-code"
                    value={code}
                    onChange={setCode}
                    disabled={busy}
                  />
                )}
                <button
                  className="text-link owner-recovery-toggle"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setUseRecovery((value) => !value);
                    setCode("");
                    setRecoveryCode("");
                    setError("");
                  }}
                >
                  {useRecovery
                    ? "Use my authenticator instead"
                    : "Use a recovery code instead"}
                </button>
                <ErrorNotice message={error} />
                <button
                  className="button primary full-width"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <LockKeyhole size={17} />
                  )}
                  Sign in securely <ArrowRight size={17} />
                </button>
              </form>
              <p className="owner-small-note">
                Owner sessions close after inactivity. Your password and codes
                stay out of browser storage.
              </p>
            </>
          ) : (
            <>
              <div className="owner-unavailable-icon">
                <KeyRound size={31} strokeWidth={1.4} />
              </div>
              <span className="eyebrow">OWNER ACCESS</span>
              <h2>
                {status && !status.configured
                  ? "Your private setup link."
                  : "Let’s reconnect."}
              </h2>
              <p className="owner-description">
                {status && !status.configured
                  ? "Open your private activation link to create the owner account. This page never allows public registration."
                  : "We couldn’t open owner access just now. Please try again shortly."}
              </p>
              <ErrorNotice message={error} />
              <button
                type="button"
                className="button secondary full-width"
                onClick={onBack}
              >
                Explore the store <ArrowRight size={17} />
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function OwnerAuthenticatorReset({ session, onComplete, onCancel, notify }) {
  const [phase, setPhase] = useState("start");
  const [password, setPassword] = useState("");
  const [recoveryProof, setRecoveryProof] = useState("");
  const [enrollment, setEnrollment] = useState(null);
  const [qrImage, setQrImage] = useState("");
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enrollment?.otpauthUrl) {
      setQrImage("");
      return;
    }
    let stopped = false;
    QRCode.toDataURL(enrollment.otpauthUrl, {
      width: 224,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#193c31", light: "#ffffff" },
    })
      .then((value) => {
        if (!stopped) setQrImage(value);
      })
      .catch(() => {
        if (!stopped) setQrImage("");
      });
    return () => {
      stopped = true;
    };
  }, [enrollment?.otpauthUrl]);
  const start = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await ownerRequest("/mfa/reset/start", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { currentPassword: password, recoveryCode: recoveryProof.trim() },
      });
      setPassword("");
      setRecoveryProof("");
      setEnrollment(response);
      setCode("");
      setPhase("verify");
    } catch (requestError) {
      setError(requestError.message);
      setRecoveryProof("");
    } finally {
      setBusy(false);
    }
  };
  const verify = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await ownerRequest("/mfa/reset/complete", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { flowToken: enrollment.flowToken, code },
      });
      setResult(response);
      setEnrollment(null);
      setCode("");
      setPhase("recovery");
    } catch (requestError) {
      setError(requestError.message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    const contents = `LEAFIVO OWNER RECOVERY CODES\n\nOwner: ${result?.owner?.username || session.owner?.username || "owner"}\n\n${(result?.recoveryCodes || []).join("\n")}\n\nThese replace your previous recovery codes. Each can be used once with your password. Keep them offline somewhere private. Never send them to support or post them online.\n`;
    const url = URL.createObjectURL(
      new Blob([contents], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "leafivo-owner-recovery-codes.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="owner-authenticator-reset">
      {phase === "start" ? (
        <>
          <span className="eyebrow">REPLACE YOUR AUTHENTICATOR</span>
          <h2>A new phone. A fresh key.</h2>
          <p className="owner-description">
            Confirm your password and one unused recovery code to connect a
            replacement authenticator. This consumes that recovery code. If you
            signed in with a recovery code, use a different one here.
          </p>
          <form onSubmit={start}>
            <PasswordField
              id="owner-reset-password"
              label="Current password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
            <label
              className="field-label owner-field"
              htmlFor="owner-reset-recovery"
            >
              Unused recovery code
              <input
                className="text-input owner-recovery-input"
                id="owner-reset-recovery"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={128}
                value={recoveryProof}
                onChange={(event) => setRecoveryProof(event.target.value)}
                required
                disabled={busy}
              />
            </label>
            <ErrorNotice message={error} />
            <button
              className="button primary full-width"
              type="submit"
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Smartphone size={17} />
              )}
              Connect a replacement authenticator
            </button>
          </form>
        </>
      ) : phase === "verify" ? (
        <>
          <span className="eyebrow">VERIFY THE NEW AUTHENTICATOR</span>
          <h2>Connect your new app.</h2>
          <p className="owner-description">
            Scan the code with your replacement authenticator, then enter its
            six-digit code. Your previous authenticator remains active until
            this is verified.
          </p>
          <div className="owner-qr">
            {qrImage ? (
              <img
                src={qrImage}
                width="224"
                height="224"
                alt="Replacement authenticator setup QR code"
              />
            ) : (
              <Smartphone size={35} />
            )}
          </div>
          <details className="owner-manual-secret">
            <summary>Can’t scan? Enter a setup key instead.</summary>
            <span>Account: {session.owner?.username}</span>
            <code>{enrollment?.secret}</code>
          </details>
          <form onSubmit={verify}>
            <CodeField
              id="owner-reset-code"
              value={code}
              onChange={setCode}
              disabled={busy}
            />
            <ErrorNotice message={error} />
            <button
              className="button primary full-width"
              type="submit"
              disabled={busy || code.length !== 6}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
              Verify new authenticator
            </button>
          </form>
        </>
      ) : (
        <>
          <span className="eyebrow">KEEP YOUR NEW SPARE KEYS</span>
          <h2>Save the replacement codes.</h2>
          <p className="owner-description">
            Your new authenticator is active. Other sessions have closed, and
            your previous recovery codes no longer work. Save these new codes
            before leaving this page.
          </p>
          <div
            className="owner-recovery-codes"
            aria-label="Replacement recovery codes"
          >
            {(result?.recoveryCodes || []).map((value) => (
              <code key={value}>{value}</code>
            ))}
          </div>
          <button
            type="button"
            className="button secondary full-width"
            onClick={download}
          >
            <Download size={17} />
            Download replacement recovery codes
          </button>
          <label className="checkbox-label owner-saved-checkbox">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            I saved the new codes somewhere private.
          </label>
          <button
            type="button"
            className="button primary full-width"
            disabled={!saved}
            onClick={() => {
              if (!saved || !result) return;
              const next = { owner: result.owner, csrfToken: result.csrfToken };
              setResult(null);
              notify("Your authenticator has been replaced.");
              onComplete(next);
            }}
          >
            Finish authenticator replacement <Check size={17} />
          </button>
        </>
      )}
      {phase !== "recovery" && (
        <button
          type="button"
          className="text-link owner-reset-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          <ArrowLeft size={14} />
          Back to owner security
        </button>
      )}
    </div>
  );
}

export function OwnerSecurity({
  session,
  onSessionUpdate = emptyAction,
  onLogout = emptyAction,
  notify = emptyAction,
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [resettingAuthenticator, setResettingAuthenticator] = useState(false);
  const clear = () => {
    setCurrentPassword("");
    setPassword("");
    setConfirmation("");
    setCode("");
  };
  const changePassword = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    if (password !== confirmation) {
      setError("Your new passwords do not match.");
      return;
    }
    if (!session?.csrfToken) {
      setError(
        "Your session has expired. Sign in again to change your password.",
      );
      return;
    }
    setBusy(true);
    try {
      const result = await ownerRequest("/passwordchange", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { currentPassword, password, code },
      });
      clear();
      onSessionUpdate({ owner: result.owner, csrfToken: result.csrfToken });
      setMessage(
        "Your password is updated. Other owner sessions have been signed out.",
      );
      notify("Owner password updated.");
    } catch (requestError) {
      setError(requestError.message);
      setCode("");
      if (requestError.code === "OWNER_SIGN_IN_REQUIRED") {
        clear();
        onLogout();
      }
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setLoggingOut(true);
    setError("");
    try {
      await ownerRequest("/logout", {
        method: "POST",
        csrfToken: session?.csrfToken,
        body: {},
      });
      clear();
      onLogout();
    } catch (requestError) {
      if (requestError.code === "OWNER_SIGN_IN_REQUIRED") {
        clear();
        onLogout();
      } else setError(requestError.message);
    } finally {
      setLoggingOut(false);
    }
  };
  if (resettingAuthenticator)
    return (
      <section className="owner-security studio-card">
        <OwnerAuthenticatorReset
          session={session}
          notify={notify}
          onCancel={() => setResettingAuthenticator(false)}
          onComplete={(next) => {
            setResettingAuthenticator(false);
            onSessionUpdate(next);
            setMessage("Your authenticator and recovery codes are updated.");
          }}
        />
      </section>
    );
  return (
    <section
      className="owner-security studio-card"
      aria-labelledby="owner-security-heading"
    >
      <div className="owner-security-heading">
        <div>
          <span className="eyebrow">YOUR PRIVATE ACCESS</span>
          <h2 id="owner-security-heading">Owner security.</h2>
        </div>
        <ShieldCheck size={25} strokeWidth={1.4} />
      </div>
      <p className="owner-description">
        Signed in as <strong>{session?.owner?.username || "owner"}</strong>.
        Change your password with a fresh authenticator code. All other owner
        sessions will close.
      </p>
      <form onSubmit={changePassword}>
        <PasswordField
          id="owner-security-current"
          label="Current password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          disabled={busy || loggingOut}
        />
        <PasswordField
          id="owner-security-new"
          label="New password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          newPassword
          disabled={busy || loggingOut}
        />
        <PasswordField
          id="owner-security-confirm"
          label="Confirm new password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="new-password"
          newPassword
          disabled={busy || loggingOut}
        />
        <CodeField
          id="owner-security-code"
          value={code}
          onChange={setCode}
          disabled={busy || loggingOut}
        />
        <p className="owner-small-note">
          Use the next new code if you have just signed in. An authenticator
          code can only be used once.
        </p>
        <ErrorNotice message={error} />
        {message && (
          <p className="owner-success" role="status">
            <Check size={17} />
            {message}
          </p>
        )}
        <div className="owner-security-actions">
          <button
            className="button primary"
            type="submit"
            disabled={busy || loggingOut}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <ShieldCheck size={17} />
            )}
            Update password
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy || loggingOut}
            onClick={logout}
          >
            {loggingOut ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <LogOut size={17} />
            )}
            Sign out
          </button>
        </div>
      </form>
      <div className="owner-authenticator-option">
        <Smartphone size={23} strokeWidth={1.4} />
        <div>
          <h3>Need to replace your authenticator?</h3>
          <p>
            Connect a new device using your password and an unused recovery
            code.
          </p>
          <button
            className="text-link"
            type="button"
            disabled={busy || loggingOut}
            onClick={() => {
              clear();
              setError("");
              setMessage("");
              setResettingAuthenticator(true);
            }}
          >
            Replace my authenticator <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}

export default OwnerAccess;
