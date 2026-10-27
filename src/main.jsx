import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  BookOpen,
  ShoppingBag,
  Search,
  X,
  Plus,
  Minus,
  Heart,
  Check,
  ChevronDown,
  Download,
  Sparkles,
  ShieldCheck,
  Mail,
  Menu,
  LayoutDashboard,
  Package,
  Megaphone,
  Copy,
  LogOut,
  LoaderCircle,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import "@fontsource-variable/dm-sans";
import "./styles.css";
import OwnerAccess, { OwnerSecurity } from "./OwnerAccess.jsx";

const money = (cents, currency = "usd") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);
const readLocal = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const safeSave = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Shopping remains available when browser storage is disabled. */
  }
};
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The store could not be reached. Please try again.");
  }
  if (!response.ok) {
    const error = new Error(
      data.error?.message ||
        data.error ||
        data.message ||
        "Something went wrong. Please try again.",
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

function Cover({ product, className = "" }) {
  const style = product.cover || "sage";
  return (
    <div
      className={`book-cover cover-${style} ${className}`}
      aria-label={`${product.title} cover`}
    >
      <div className="cover-top">
        <span>LEAFIVO EDITIONS</span>
        <span>
          №{" "}
          {String(
            { sage: 1, peach: 2, yellow: 3, blue: 4, ink: 5, pink: 6 }[style] ||
              1,
          ).padStart(2, "0")}
        </span>
      </div>
      <div className="cover-title">{product.title}</div>
      <div className={`cover-art art-${style}`} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="cover-bottom">
        <span>{product.subtitle || "A little guide to new possibilities"}</span>
        <ArrowUpRight size={20} />
      </div>
    </div>
  );
}
function Modal({ children, onClose, label, className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const items = [
          ...ref.current.querySelectorAll(
            'button:not(:disabled),a,input,select,textarea,[tabindex="0"]',
          ),
        ];
        if (!items.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className={`modal-backdrop ${className}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="modal-panel"
      >
        <button
          className="icon-button modal-close"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={22} />
        </button>
        {children}
      </section>
    </div>
  );
}
function App() {
  const [store, setStore] = useState(null),
    [error, setError] = useState("");
  const [category, setCategory] = useState("All products"),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("featured");
  const [cart, setCart] = useState(() => {
    const v = readLocal("chapter.cart", []);
    return Array.isArray(v)
      ? v.filter(
          (i) =>
            i &&
            typeof i.productId === "string" &&
            Number.isInteger(i.quantity) &&
            i.quantity > 0 &&
            i.quantity <= 10,
        )
      : [];
  });
  const [favorites, setFavorites] = useState(() => {
    const v = readLocal("chapter.favorites", []);
    return Array.isArray(v)
      ? v.filter((id) => typeof id === "string").slice(0, 500)
      : [];
  });
  const [modal, setModal] = useState(null),
    [selected, setSelected] = useState(null),
    [toast, setToast] = useState("");
  const [searchOpen, setSearchOpen] = useState(false),
    [mobileMenu, setMobileMenu] = useState(false),
    [studio, setStudio] = useState(
      location.hash === "#studio" || location.hash.startsWith("#owner"),
    );
  const [email, setEmail] = useState(""),
    [consent, setConsent] = useState(false),
    [newsletterStatus, setNewsletterStatus] = useState(""),
    [newsletterBusy, setNewsletterBusy] = useState(false);
  const [checkoutEmail, setCheckoutEmail] = useState(""),
    [checkoutBusy, setCheckoutBusy] = useState(false),
    [checkoutError, setCheckoutError] = useState(""),
    [order, setOrder] = useState(null),
    [receipt, setReceipt] = useState(null),
    [receiptError, setReceiptError] = useState(""),
    [receiptLoading, setReceiptLoading] = useState(false);
  const receiptCapability = useRef(null);
  const load = () =>
    api("/api/store")
      .then(setStore)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const listener = () =>
      setStudio(
        location.hash === "#studio" || location.hash.startsWith("#owner"),
      );
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("checkout") === "cancelled") {
      setToast("Payment cancelled. Your bag is still here.");
      history.replaceState({}, "", location.pathname + location.hash);
      return;
    }
    if (
      params.get("checkout") !== "success" ||
      !location.hash.startsWith("#receipt?")
    )
      return;
    const capability = new URLSearchParams(location.hash.slice(9));
    // Fragments are never sent to the web server. Remove this capability before any other navigation.
    history.replaceState({}, "", location.pathname);
    if (!capability.get("order") || !capability.get("token")) return;
    receiptCapability.current = {
      id: capability.get("order"),
      token: capability.get("token"),
    };
    setModal("receipt");
    let stopped = false,
      timer;
    let tries = 0;
    const check = async () => {
      setReceiptLoading(true);
      try {
        const key = receiptCapability.current;
        const result = await api(`/api/orders/${encodeURIComponent(key.id)}`, {
          headers: { Authorization: `Bearer ${key.token}` },
        });
        if (stopped) return;
        setReceipt(result);
        setReceiptError("");
        if (result.status === "paid") {
          setCart([]);
        } else if (result.status === "pending" && ++tries < 12) {
          timer = setTimeout(check, 2500);
        }
      } catch (e) {
        if (!stopped) setReceiptError(e.message);
      } finally {
        if (!stopped) setReceiptLoading(false);
      }
    };
    check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => safeSave("chapter.cart", cart), [cart]);
  useEffect(() => safeSave("chapter.favorites", favorites), [favorites]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(timer);
  }, [toast]);
  const products = store?.products || [];
  useEffect(() => {
    const sync = () => {
      if (location.hash.startsWith("#product/")) {
        const id = location.hash.slice(9);
        const product = store?.products.find((p) => p.id === id);
        if (product) {
          setSelected(product);
          setModal("product");
          setStudio(false);
        }
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [store]);
  useEffect(() => {
    document.title =
      modal === "product" && selected
        ? `${selected.title} — ${store?.name || "Leafivo"}`
        : `${store?.name || "Leafivo"} — Small ideas. New possibilities.`;
  }, [modal, selected, store]);
  const lines = cart
    .map((i) => ({ ...i, product: products.find((p) => p.id === i.productId) }))
    .filter((i) => i.product);
  const receiptRevoked = ["refunded", "disputed"].includes(receipt?.status);
  const count = lines.reduce((s, i) => s + i.quantity, 0),
    total = lines.reduce((s, i) => s + i.product.price * i.quantity, 0);
  const filtered = useMemo(
    () =>
      products
        .filter(
          (p) =>
            (category === "All products" ||
              (category === "Saved"
                ? favorites.includes(p.id)
                : p.category === category)) &&
            `${p.title} ${p.subtitle} ${p.description}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "price-low"
            ? a.price - b.price
            : sort === "price-high"
              ? b.price - a.price
              : sort === "name"
                ? a.title.localeCompare(b.title)
                : Number(b.featured) - Number(a.featured),
        ),
    [products, category, query, sort, favorites],
  );
  const add = (p) => {
    setCart((current) => {
      const found = current.find((i) => i.productId === p.id);
      return found
        ? current.map((i) =>
            i.productId === p.id
              ? { ...i, quantity: Math.min(i.quantity + 1, 10) }
              : i,
          )
        : [...current, { productId: p.id, quantity: 1 }];
    });
    setToast(`${p.title} added to your bag`);
  };
  const updateQty = (id, delta) =>
    setCart((current) =>
      current
        .map((i) =>
          i.productId === id
            ? { ...i, quantity: Math.min(10, i.quantity + delta) }
            : i,
        )
        .filter((i) => i.quantity > 0),
    );
  const favorite = (id) =>
    setFavorites((current) =>
      current.includes(id) ? current.filter((i) => i !== id) : [...current, id],
    );
  const browse = (cat = "All products") => {
    setStudio(false);
    location.hash = "shop";
    setCategory(cat);
    setMobileMenu(false);
    setTimeout(
      () =>
        document.getElementById("shop")?.scrollIntoView({ behavior: "smooth" }),
      50,
    );
  };
  const openProduct = (p) => {
    setSelected(p);
    setModal("product");
    location.hash = `product/${p.id}`;
  };
  const subscribe = async (e) => {
    e.preventDefault();
    setNewsletterBusy(true);
    setNewsletterStatus("");
    try {
      await api("/api/newsletter", {
        method: "POST",
        body: JSON.stringify({ email, consent }),
      });
      setNewsletterStatus(
        "You’re on the list. Your interest has been saved; email updates will begin after launch.",
      );
      setEmail("");
      setConsent(false);
    } catch (e) {
      setNewsletterStatus(e.message);
    } finally {
      setNewsletterBusy(false);
    }
  };
  const checkout = async (e) => {
    e.preventDefault();
    setCheckoutBusy(true);
    setCheckoutError("");
    try {
      const result = await api("/api/checkout", {
        method: "POST",
        body: JSON.stringify({
          ...(store.publicPreview ? {} : { email: checkoutEmail }),
          items: lines.map(({ productId, quantity }) => ({
            productId,
            quantity,
          })),
        }),
      });
      if (result.mode === "live" && result.url) {
        window.location.assign(result.url);
        return;
      }
      setOrder(result.order);
      setCart([]);
      setModal("confirmation");
    } catch (e) {
      setCheckoutError(e.message);
    } finally {
      setCheckoutBusy(false);
    }
  };
  if (error)
    return (
      <main className="loading-page">
        <BookOpen size={40} />
        <h1>Let’s reconnect.</h1>
        <p>{error}</p>
        <button
          className="button primary"
          onClick={() => {
            setError("");
            load();
          }}
        >
          Try again <ArrowRight size={18} />
        </button>
      </main>
    );
  if (!store)
    return (
      <main className="loading-page">
        <BookOpen size={40} />
        <span>Opening a new chapter…</span>
        <LoaderCircle className="spin" />
      </main>
    );
  return (
    <>
      <div className="announcement">
        <span>A little knowledge. A world of possibility.</span>
        <span className="preview-label">
          <i />
          {store.mode === "preview"
            ? "Preview store · Sample products"
            : "Independent ideas, thoughtfully made"}
        </span>
      </div>
      <header className="site-header">
        <a
          className="brand"
          href="#"
          onClick={() => {
            setStudio(false);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          aria-label="Leafivo home"
        >
          <BookOpen strokeWidth={1.8} />
          <span>
            {store.name || "Leafivo"}
            <b>✳︎</b>
          </span>
        </a>
        <nav
          className={mobileMenu ? "nav-open" : ""}
          aria-label="Main navigation"
        >
          <button
            className={!studio ? "nav-active" : ""}
            onClick={() => browse()}
          >
            The shop
          </button>
          <button onClick={() => browse("Ebooks")}>Ebooks & guides</button>
          <a
            href="#story"
            onClick={() => {
              setStudio(false);
              setMobileMenu(false);
            }}
          >
            Our story
          </a>
        </nav>
        <div className="header-actions">
          <button
            className="icon-button search-trigger"
            aria-label="Search products"
            onClick={() => {
              setSearchOpen(!searchOpen);
              browse();
            }}
          >
            <Search size={21} />
          </button>
          <button
            className="bag-button"
            onClick={() => {
              setCheckoutError("");
              setModal("cart");
            }}
            aria-label={`Open shopping bag, ${count} items`}
          >
            <ShoppingBag size={18} />
            <span>Bag</span>
            <b>{count}</b>
          </button>
          <button
            className="icon-button mobile-toggle"
            aria-label="Toggle navigation"
            aria-expanded={mobileMenu}
            onClick={() => setMobileMenu(!mobileMenu)}
          >
            <Menu size={23} />
          </button>
        </div>
      </header>
      {studio ? (
        <Studio
          products={products}
          store={store}
          onStoreUpdate={load}
          notify={setToast}
          onBack={() => browse()}
        />
      ) : (
        <main>
          <section className="hero">
            <div className="hero-copy">
              <div className="eyebrow">
                <span className="tiny-star">✳︎</span> FOR THE CURIOUS. FOR THE
                DOERS.
              </div>
              <h1>
                Your next <br />
                chapter{" "}
                <em>
                  starts
                  <br className="desktop-break" /> here.
                </em>
                <span className="hero-spark">✳︎</span>
              </h1>
              <p>
                Fresh perspectives. Practical tools. A thoughtfully
                <br className="desktop-break" /> curated collection to help you
                turn <em>someday</em> into today.
              </p>
              <button className="button primary" onClick={() => browse()}>
                Find your next chapter <ArrowUpRight size={19} />
              </button>
              <div className="hero-note">
                <span className="note-line" />
                Good ideas, ready when you are.
              </div>
            </div>
            <div
              className="hero-visual"
              aria-label="A collection of Leafivo ebooks"
            >
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <span className="visual-star star-one">✧</span>
              <span className="visual-star star-two">✳︎</span>
              <div className="hero-book book-back">
                <Cover
                  product={{
                    title: "Make Room for More",
                    cover: "peach",
                    subtitle: "A softer way to find your balance",
                  }}
                />
              </div>
              <div className="hero-book book-front">
                <Cover
                  product={{
                    title: "The Art of Starting",
                    cover: "sage",
                    subtitle: "Small steps. Remarkable beginnings.",
                  }}
                />
              </div>
              <div className="round-stamp">
                <span>SMALL DOWNLOADS.</span>
                <Sparkles size={27} strokeWidth={1.2} />
                <span>BIG POSSIBILITIES.</span>
              </div>
              <div className="visual-caption">
                <span>THE LEAFIVO COLLECTION</span>
                <span>
                  01 — 06 <ArrowUpRight size={15} />
                </span>
              </div>
            </div>
          </section>
          <section className="value-strip" aria-label="Store benefits">
            <span>
              <Download size={18} />
              Digital goods. Instant inspiration.
            </span>
            <i />
            <span>
              <BookOpen size={18} />
              Made to be put into practice.
            </span>
            <i />
            <span>
              <Heart size={18} />
              Keep it. Revisit it. Make it yours.
            </span>
          </section>
          <section className="shop-section section-wrap" id="shop">
            <div className="section-heading">
              <div>
                <div className="eyebrow">THE GOOD STUFF</div>
                <h2>
                  Made for your next move<span>.</span>
                </h2>
              </div>
              <p>
                A fresh idea could change your day.
                <br />
                Find the one that speaks to you.
              </p>
            </div>
            <div className="shop-controls">
              <div
                className="category-tabs"
                role="group"
                aria-label="Product categories"
              >
                {[
                  "All products",
                  "Ebooks",
                  "Templates",
                  "Bundles",
                  "Saved",
                ].map((c) => (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    className={category === c ? "selected" : ""}
                  >
                    {c === "Saved" ? <Heart size={14} /> : null}
                    {c}
                    {c === "All products" && <span>{products.length}</span>}
                  </button>
                ))}
              </div>
              <label className="sort-label">
                <span className="sr-only">Sort products</span>
                <select value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="featured">Featured</option>
                  <option value="price-low">Price: low to high</option>
                  <option value="price-high">Price: high to low</option>
                  <option value="name">Name: A–Z</option>
                </select>
                <ChevronDown size={14} />
              </label>
            </div>
            {(searchOpen || query) && (
              <div className="search-box">
                <Search size={19} />
                <input
                  autoFocus
                  placeholder="Find your next idea…"
                  aria-label="Search the catalog"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  className="icon-button"
                  onClick={() => {
                    setQuery("");
                    setSearchOpen(false);
                  }}
                  aria-label="Clear search"
                >
                  <X size={18} />
                </button>
              </div>
            )}
            <div className="product-grid">
              {filtered.map((p, index) => (
                <article className="product-card" key={p.id}>
                  <div className={`product-art product-bg-${p.cover}`}>
                    <button
                      className="product-image-button"
                      onClick={() => openProduct(p)}
                      aria-label={`View ${p.title}`}
                    >
                      <Cover product={p} />
                    </button>
                    <span className="product-badge">
                      {p.featured
                        ? "THE EDITOR’S PICK"
                        : p.category === "Bundles"
                          ? "BETTER TOGETHER"
                          : p.format || "DIGITAL EDITION"}
                    </span>
                    <button
                      className={`favorite-button ${favorites.includes(p.id) ? "is-favorite" : ""}`}
                      aria-label={`${favorites.includes(p.id) ? "Unsave" : "Save"} ${p.title}`}
                      aria-pressed={favorites.includes(p.id)}
                      onClick={() => favorite(p.id)}
                    >
                      <Heart
                        size={18}
                        fill={
                          favorites.includes(p.id) ? "currentColor" : "none"
                        }
                      />
                    </button>
                    <button className="quick-add" onClick={() => add(p)}>
                      Add to bag <Plus size={17} />
                    </button>
                  </div>
                  <div className="product-meta">
                    <span>
                      {p.category === "Ebooks"
                        ? "EBOOK & GUIDE"
                        : p.category.toUpperCase()}
                    </span>
                    <span>{p.format || "PDF"}</span>
                  </div>
                  <div className="product-title-row">
                    <button onClick={() => openProduct(p)}>{p.title}</button>
                    <span>{money(p.price, p.currency)}</span>
                  </div>
                  <p className="product-description">{p.subtitle}</p>
                </article>
              ))}
            </div>
            {!filtered.length && (
              <div className="empty-state">
                <Search size={30} />
                <h3>
                  {category === "Saved"
                    ? "A place for your next favorites."
                    : "A different chapter, perhaps?"}
                </h3>
                <p>
                  {category === "Saved"
                    ? "Tap the heart on a product to save it here."
                    : "Try another search or explore the whole collection."}
                </p>
                <button
                  className="text-link"
                  onClick={() => {
                    setQuery("");
                    setCategory("All products");
                  }}
                >
                  Explore all products <ArrowRight size={16} />
                </button>
              </div>
            )}
            <div className="catalog-footnote">
              <span>Thoughtful resources. Yours to make something of.</span>
              <span>
                {filtered.length} of {products.length} good ideas{" "}
                <ArrowUpRight size={15} />
              </span>
            </div>
          </section>
          <section className="bundle-section section-wrap">
            <div className="bundle-banner">
              <div className="bundle-copy">
                <div className="eyebrow">
                  <Sparkles size={15} /> A LITTLE HELP GOES A LONG WAY
                </div>
                <h2>
                  Your ideas.
                  <br />A head start.
                </h2>
                <p>
                  Meet the tools that make room for your best work.
                  <br />A little more clarity. A lot more possibility.
                </p>
                <button
                  className="button lime"
                  onClick={() => browse("Bundles")}
                >
                  Explore the bundles <ArrowUpRight size={18} />
                </button>
              </div>
              <div className="bundle-art" aria-hidden="true">
                <div className="planner-sheet">
                  <span>THE EVERYDAY</span>
                  <h3>
                    A little
                    <br />
                    more
                    <br />
                    <em>intention.</em>
                  </h3>
                  <div className="planner-lines">
                    <span>01 / MAKE SPACE</span>
                    <i />
                    <i />
                    <span>02 / FIND YOUR FOCUS</span>
                    <i />
                    <i />
                  </div>
                  <span className="sheet-footer">
                    LEAFIVO · YOUR EVERYDAY, REIMAGINED
                  </span>
                </div>
                <div className="small-book">
                  <Cover
                    product={{
                      title: "The Creator’s Toolkit",
                      cover: "blue",
                      subtitle: "Bring your next big idea to life.",
                    }}
                  />
                </div>
                <span className="bundle-asterisk">✳︎</span>
              </div>
            </div>
          </section>
          <section className="story-section section-wrap" id="story">
            <div className="story-label">
              <BookOpen size={31} strokeWidth={1.3} />
              <div className="eyebrow">A NOTE FROM LEAFIVO</div>
            </div>
            <div>
              <h2>
                For the work in progress.
                <br />
                <em>And the person behind it.</em>
              </h2>
              <div className="story-body">
                <p>
                  We believe a good resource does more than fill a folder. It
                  opens a door. To a fresh perspective, a calmer routine, or the
                  idea you’ve been meaning to start.
                </p>
                <p>
                  That’s what Leafivo is here for. Thoughtful digital goods that
                  meet you where you are — and help you take the next small
                  step.
                </p>
              </div>
              <span className="handwritten">Here’s to what comes next.</span>
            </div>
          </section>
          <section className="newsletter section-wrap">
            <div className="newsletter-inner">
              <div className="newsletter-copy">
                <span className="eyebrow">A GOOD THING IN YOUR INBOX</span>
                <h2>
                  Keep a little
                  <br />
                  <em>possibility</em> close.
                </h2>
                <p>
                  Join the list for new releases, useful ideas,
                  <br />
                  and a little nudge to get started.
                </p>
              </div>
              {store.publicPreview ? (
                <div className="newsletter-form preview-newsletter">
                  <span className="eyebrow">A FIRST LOOK AT LEAFIVO</span>
                  <h3>Good things are on the way.</h3>
                  <p>
                    Explore the collection and find your favorites. Email
                    signups will open when the store launches.
                  </p>
                  <span className="small-note">
                    Public preview · Email collection is turned off.
                  </span>
                </div>
              ) : (
                <form onSubmit={subscribe} className="newsletter-form">
                  <label htmlFor="newsletter-email">
                    Your next chapter, delivered.
                  </label>
                  <div className="email-field">
                    <input
                      id="newsletter-email"
                      type="email"
                      required
                      maxLength={254}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Your email address"
                    />
                    <button
                      type="submit"
                      disabled={!consent || newsletterBusy}
                      aria-label="Join the email list"
                    >
                      {newsletterBusy ? (
                        <LoaderCircle className="spin" size={21} />
                      ) : (
                        <ArrowRight size={23} />
                      )}
                    </button>
                  </div>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      required
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      I agree to receive Leafivo updates. Unsubscribe anytime.
                    </span>
                  </label>
                  <p className="newsletter-disclaimer">
                    Preview: signups are saved securely. No emails are sent yet.
                  </p>
                  <p className="form-status" role="status">
                    {newsletterStatus}
                  </p>
                </form>
              )}
              <span className="newsletter-flower" aria-hidden="true">
                ✳︎
              </span>
            </div>
          </section>
        </main>
      )}
      <footer className="site-footer section-wrap">
        <div className="footer-main">
          <div>
            <a href="#" className="brand" onClick={() => setStudio(false)}>
              <BookOpen strokeWidth={1.8} />
              <span>
                {store.name || "Leafivo"}
                <b>✳︎</b>
              </span>
            </a>
            <p>Small ideas. New possibilities.</p>
          </div>
          <div className="footer-links">
            <div>
              <span>THE COLLECTION</span>
              <button onClick={() => browse()}>Shop all</button>
              <button onClick={() => browse("Ebooks")}>Ebooks & guides</button>
              <button onClick={() => browse("Templates")}>
                Templates & tools
              </button>
            </div>
            <div>
              <span>A LITTLE MORE</span>
              <a href="#story" onClick={() => setStudio(false)}>
                Our story
              </a>
              <button onClick={() => setModal("help")}>
                Questions & answers
              </button>
              <a
                href="#owner"
                onClick={() => {
                  setStudio(true);
                  window.scrollTo(0, 0);
                }}
              >
                Owner sign in <ShieldCheck size={12} />
              </a>
              <button
                onClick={() => {
                  location.hash = "studio";
                  setStudio(true);
                  window.scrollTo(0, 0);
                }}
              >
                Store studio <ArrowUpRight size={12} />
              </button>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <span>
            © {new Date().getFullYear()} {store.name || "Leafivo"}. Made for
            what’s next.
          </span>
          <div>
            <button onClick={() => setModal("privacy")}>Privacy</button>
            <button onClick={() => setModal("terms")}>Terms & refunds</button>
            <span>USD $</span>
          </div>
        </div>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={19} />
          {toast}
        </div>
      )}
      {modal === "product" && selected && (
        <Modal
          onClose={() => {
            setModal(null);
            history.replaceState(
              {},
              "",
              location.pathname + location.search + "#shop",
            );
          }}
          label={selected.title}
          className="product-modal"
        >
          <div className={`detail-art product-bg-${selected.cover}`}>
            <Cover product={selected} />
            <span className="eyebrow">
              {selected.sample
                ? "A LEAFIVO ORIGINAL · SAMPLE EDITION"
                : "A LEAFIVO ORIGINAL · DIGITAL EDITION"}
            </span>
          </div>
          <div className="detail-copy">
            <span className="eyebrow">
              {selected.category} / {selected.format}
            </span>
            <h2>{selected.title}</h2>
            <p className="detail-subtitle">{selected.subtitle}</p>
            <p>{selected.description}</p>
            <ul className="detail-list">
              {selected.details?.map((d) => (
                <li key={d}>
                  <Check size={16} />
                  {d}
                </li>
              ))}
            </ul>
            <div className="detail-specs">
              <span>
                <BookOpen size={16} />
                {selected.pages
                  ? `${selected.pages} pages`
                  : "Digital collection"}
              </span>
              <span>
                <Download size={16} />
                {selected.format}
              </span>
            </div>
            <button
              className="button primary full-width"
              onClick={() => add(selected)}
            >
              Add to bag — {money(selected.price, selected.currency)}{" "}
              <Plus size={18} />
            </button>
            <p className="small-note">
              {selected.sample
                ? "Sample product for exploring the store. No ebook file is included."
                : "Digital product. Delivery after payment confirmation."}
            </p>
          </div>
        </Modal>
      )}
      {(modal === "cart" || modal === "checkout") && (
        <Modal
          onClose={() => setModal(null)}
          label={modal === "cart" ? "Your shopping bag" : "Checkout"}
          className="cart-modal"
        >
          <div className="cart-heading">
            <span className="eyebrow">A FEW GOOD CHOICES</span>
            <h2>
              {modal === "cart" ? "Your book bag." : "One step closer."}
              <sup>{count}</sup>
            </h2>
          </div>
          {lines.length ? (
            <>
              <div className="cart-lines">
                {lines.map(({ product: p, quantity }) => (
                  <div className="cart-line" key={p.id}>
                    <div className={`cart-thumbnail product-bg-${p.cover}`}>
                      <Cover product={p} />
                    </div>
                    <div className="cart-line-info">
                      <span className="eyebrow">{p.category}</span>
                      <h3>{p.title}</h3>
                      <span className="small-note">
                        {p.format} ·{" "}
                        {p.sample ? "Sample product" : "Digital product"}
                      </span>
                      <div className="quantity">
                        <button
                          onClick={() => updateQty(p.id, -1)}
                          aria-label={`Decrease ${p.title} quantity`}
                        >
                          <Minus size={13} />
                        </button>
                        <span aria-label="Quantity">{quantity}</span>
                        <button
                          disabled={quantity >= 10}
                          onClick={() => updateQty(p.id, 1)}
                          aria-label={`Increase ${p.title} quantity`}
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                    </div>
                    <div className="cart-line-end">
                      <strong>{money(p.price * quantity, p.currency)}</strong>
                      <button
                        aria-label={`Remove ${p.title}`}
                        onClick={() =>
                          setCart((c) => c.filter((i) => i.productId !== p.id))
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="cart-summary">
                <div>
                  <span>Subtotal</span>
                  <strong>{money(total, store.currency)}</strong>
                </div>
                <p>
                  {store.mode === "preview"
                    ? "Preview only. No payment will be collected."
                    : "Any applicable taxes are calculated at secure checkout."}
                </p>
                {modal === "checkout" ? (
                  <form onSubmit={checkout}>
                    {!store.publicPreview && (
                      <>
                        <label className="field-label" htmlFor="checkout-email">
                          Email for your order
                        </label>
                        <input
                          className="text-input"
                          id="checkout-email"
                          type="email"
                          required
                          maxLength={254}
                          value={checkoutEmail}
                          onChange={(e) => setCheckoutEmail(e.target.value)}
                          placeholder="you@example.com"
                        />
                      </>
                    )}
                    <p className="checkout-notice">
                      <ShieldCheck size={19} />
                      {store.mode === "preview"
                        ? store.publicPreview
                          ? "Try the checkout without sharing personal details. Nothing is charged, saved, or delivered."
                          : "This is a practice checkout. Your sample order will be saved, with no charge or product delivery."
                        : "You’ll continue to Stripe to pay securely. Digital products are available after payment is verified."}
                    </p>
                    {checkoutError && (
                      <p className="error-text" role="alert">
                        {checkoutError}
                      </p>
                    )}
                    <button
                      className="button primary full-width"
                      type="submit"
                      disabled={checkoutBusy}
                    >
                      {checkoutBusy ? (
                        <>
                          <LoaderCircle className="spin" size={18} />
                          Preparing…
                        </>
                      ) : (
                        <>
                          {store.mode === "preview"
                            ? "Place sample order"
                            : "Continue to secure payment"}
                          <ArrowRight size={18} />
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="text-link back-to-bag"
                      onClick={() => setModal("cart")}
                    >
                      <ArrowLeft size={14} />
                      Back to bag
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className="button primary full-width"
                      onClick={() => setModal("checkout")}
                    >
                      {store.mode === "preview"
                        ? "Try preview checkout"
                        : "Go to checkout"}
                      <ArrowRight size={18} />
                    </button>
                    <button
                      className="text-link continue-shopping"
                      onClick={() => {
                        setModal(null);
                        browse();
                      }}
                    >
                      A little more browsing <ArrowUpRight size={15} />
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <ShoppingBag size={42} strokeWidth={1} />
              <h3>Your next idea is out there.</h3>
              <p>Make a little room for something good.</p>
              <button
                className="button primary"
                onClick={() => {
                  setModal(null);
                  browse();
                }}
              >
                Explore the collection <ArrowRight size={17} />
              </button>
            </div>
          )}
        </Modal>
      )}
      {modal === "receipt" && (
        <Modal
          onClose={() => setModal(null)}
          label="Payment status and downloads"
          className="info-modal"
        >
          <div className="confirmation-icon">
            {receipt?.status === "paid" ? (
              <Check size={35} />
            ) : (
              <ShieldCheck size={31} />
            )}
          </div>
          <span className="eyebrow">
            {receipt?.status === "paid"
              ? "PAYMENT CONFIRMED"
              : receiptRevoked
                ? "DOWNLOAD ACCESS ON HOLD"
                : "CHECKING YOUR PAYMENT"}
          </span>
          <h2>
            {receipt?.status === "paid"
              ? "Your next chapter."
              : receiptRevoked
                ? "Access on hold."
                : "Almost there."}
          </h2>
          <p>
            {receipt?.status === "paid"
              ? "Your payment has been verified. Download your digital products below. Keep this window open until you’ve saved your files."
              : receiptRevoked
                ? "This order has been refunded or disputed. Downloads are unavailable. Contact the store owner for help."
                : "We’re waiting for the payment provider to confirm your order. A return from checkout alone does not confirm payment."}
          </p>
          {receiptError && (
            <p className="error-text" role="alert">
              {receiptError}
            </p>
          )}
          {receipt?.status === "paid" ? (
            <div className="download-list">
              {receipt.items.map((item) => (
                <div key={item.productId}>
                  <span>{item.title}</span>
                  {item.downloadUrl ? (
                    <a
                      href={item.downloadUrl}
                      className="button primary"
                      download
                    >
                      <Download size={16} />
                      Download
                    </a>
                  ) : (
                    <span className="small-note">
                      File unavailable. Contact the store owner.
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <button
              className="button primary full-width"
              disabled={receiptLoading}
              onClick={async () => {
                setReceiptLoading(true);
                try {
                  const key = receiptCapability.current;
                  const result = await api(
                    `/api/orders/${encodeURIComponent(key.id)}`,
                    { headers: { Authorization: `Bearer ${key.token}` } },
                  );
                  setReceipt(result);
                  setReceiptError("");
                  if (result.status === "paid") setCart([]);
                } catch (e) {
                  setReceiptError(e.message);
                } finally {
                  setReceiptLoading(false);
                }
              }}
            >
              {receiptLoading ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
              Check payment status
            </button>
          )}
          <p className="small-note">
            Receipt access expires after 24 hours and download links expire
            after one hour. This preview does not send receipt emails yet. For a
            paid order, save your files before closing.
          </p>
        </Modal>
      )}
      {modal === "confirmation" && (
        <Modal
          onClose={() => setModal(null)}
          label="Sample order confirmation"
          className="info-modal"
        >
          <div className="confirmation-icon">
            <Check size={35} />
          </div>
          <span className="eyebrow">PREVIEW COMPLETE</span>
          <h2>
            A promising
            <br />
            <em>first chapter.</em>
          </h2>
          <p>
            {store.publicPreview
              ? "Your practice checkout is complete. No payment was taken, no order or email was saved, and no products will be delivered."
              : "Your sample order has been saved. No payment was taken and no products will be delivered."}
          </p>
          <div className="order-receipt">
            <span>Sample order</span>
            <strong>{order?.id?.slice(-8).toUpperCase()}</strong>
            <span>Preview total</span>
            <strong>
              {money(order?.total || 0, order?.currency || "usd")}
            </strong>
          </div>
          <button
            className="button primary full-width"
            onClick={() => {
              setModal(null);
              browse();
            }}
          >
            Keep exploring <ArrowRight size={18} />
          </button>
        </Modal>
      )}
      {["privacy", "terms", "help"].includes(modal) && (
        <Modal
          onClose={() => setModal(null)}
          label={
            modal === "help"
              ? "Questions and answers"
              : modal === "privacy"
                ? "Privacy information"
                : "Terms and refunds"
          }
          className="info-modal legal-modal"
        >
          <span className="eyebrow">THE SMALL PRINT, SIMPLIFIED</span>
          <h2>
            {modal === "help"
              ? "Good questions."
              : modal === "privacy"
                ? "Your privacy."
                : "Before you buy."}
          </h2>
          {modal === "help" ? (
            <>
              <h3>Is this store open for orders?</h3>
              <p>
                {store.mode === "preview"
                  ? "This is a working preview with illustrative products. You can explore the store and place a sample order without being charged."
                  : "Checkout uses secure hosted payment. See each product for its format and contents."}
              </p>
              <h3>How do digital downloads work?</h3>
              <p>
                For real products, downloads become available after the payment
                provider confirms payment. Sample products do not contain
                downloadable files.
              </p>
              <h3>Can I sell my own products here?</h3>
              <p>
                The owner can manage the catalog and review signups and orders
                in Store studio. Product rights, payment setup, and business
                policies must be completed before launch.
              </p>
            </>
          ) : modal === "privacy" ? (
            <>
              <p>
                This preview stores your bag and saved products in your browser.{" "}
                {store.publicPreview
                  ? "This public preview does not accept email signups or payments and does not save orders. The hosting provider may retain standard request logs."
                  : "If you submit an email signup or sample order, that email and order details are stored on this store’s server for the owner to review."}
              </p>
              <p>
                Email updates are not sent automatically. There are no
                advertising trackers in this preview. Payment card details will
                be handled by Stripe when live checkout is enabled.
              </p>
              <h3>Before public launch</h3>
              <p>
                The owner must add the business’s identity, privacy contact,
                retention and deletion policy, email unsubscribe process, and
                any required consent controls. This notice is a preview
                disclosure, not a completed business privacy policy.
              </p>
            </>
          ) : (
            <>
              <p>
                All currently labeled sample products are examples. Preview
                checkout does not take payment, transfer ownership, or deliver
                an ebook.
              </p>
              <h3>Educational use and content rights</h3>
              <p>
                This store is intended for lawful educational resources. Sellers
                must own or hold the necessary rights to every product. An
                educational label does not grant permission to copy or resell
                another person’s work. Buyers must follow each product’s
                license.
              </p>
              <h3>For a live store</h3>
              <p>
                The owner must publish product licenses, fulfillment details, a
                support contact, applicable refund and cancellation rights, and
                business terms before accepting payment. Digital products are
                not automatically exempt from consumer protection laws.
              </p>
              <p>
                Prices display in USD. Any live tax collection and consumer
                disclosures must be configured for the countries you serve.
              </p>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

function Studio({ products, store, onStoreUpdate, notify, onBack }) {
  const [tab, setTab] = useState(
      location.hash.startsWith("#owner") ? "overview" : "launch",
    ),
    [token, setToken] = useState(""),
    [auth, setAuth] = useState(""),
    [overview, setOverview] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(null),
    [deleting, setDeleting] = useState(null),
    [draft, setDraft] = useState(null),
    [uploadFile, setUploadFile] = useState(null),
    [uploadRights, setUploadRights] = useState(false),
    [sessionLoading, setSessionLoading] = useState(Boolean(store.ownerAccess)),
    [ownerLocked, setOwnerLocked] = useState(false),
    [captionEdit, setCaptionEdit] = useState(null),
    [channel, setChannel] = useState("Instagram"),
    [productId, setProductId] = useState(products[0]?.id || "");
  const clearOwner = () => {
    setAuth("");
    setOverview(null);
    setEditing(null);
    setDraft(null);
    setUploadFile(null);
  };
  const headers = store.ownerAccess
    ? { "X-CSRF-Token": auth?.csrfToken || "" }
    : { Authorization: `Bearer ${auth}` };
  const refresh = async (secret = auth) => {
    try {
      const result = await api("/api/admin/overview", {
        headers: store.ownerAccess
          ? { "X-CSRF-Token": secret?.csrfToken || "" }
          : { Authorization: `Bearer ${secret}` },
      });
      setOverview(result);
    } catch (e) {
      if (e.status === 401 && store.ownerAccess) clearOwner();
      throw e;
    }
  };
  const signOut = async () => {
    try {
      if (store.ownerAccess && auth)
        await api("/api/owner/logout", { method: "POST", headers, body: "{}" });
    } catch (error) {
      if (error.status !== 401) {
        setError(
          "Sign-out could not be confirmed. Check your connection and try again.",
        );
        return false;
      }
    }
    clearOwner();
    return true;
  };
  useEffect(() => {
    const route = () => {
      if (location.hash.startsWith("#owner")) setTab("overview");
    };
    route();
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, []);
  useEffect(() => {
    if (!store.ownerAccess) return;
    let cancelled = false;
    api("/api/owner/session")
      .then(async (session) => {
        if (cancelled) return;
        if (session.authenticated) {
          setAuth(session);
          await refresh(session);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [store.ownerAccess]);
  useEffect(() => {
    if (!auth) return;
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(
        async () => {
          const signedOut = await signOut();
          if (!signedOut) {
            setOwnerLocked(true);
            clearOwner();
          }
          notify(
            signedOut
              ? "Owner access closed after inactivity. Sign in again to continue."
              : "Owner screen locked. Server sign-out could not be confirmed. Sign in again when online.",
          );
        },
        15 * 60 * 1000,
      );
    };
    reset();
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [auth]);
  useEffect(() => {
    setUploadFile(null);
    setUploadRights(false);
  }, [editing]);
  const product = products.find((p) => p.id === productId) || products[0];
  const login = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await refresh(token);
      setAuth(token);
      setToken("");
      setTab("overview");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = Object.fromEntries(
        [
          "title",
          "subtitle",
          "description",
          "category",
          "cover",
          "format",
          "featured",
          "sample",
          "downloadFile",
        ]
          .filter((k) => k in draft)
          .map((k) => [k, draft[k]]),
      );
      if (uploadFile && !uploadRights)
        throw new Error(
          "Confirm that you own or are licensed to distribute this file.",
        );
      if (uploadFile && uploadFile.size > 25 * 1024 * 1024)
        throw new Error("Choose a file no larger than 25 MB.");
      const saved = await api(
        editing === "new"
          ? "/api/admin/products"
          : `/api/admin/products/${editing}`,
        {
          method: editing === "new" ? "POST" : "PUT",
          headers,
          body: JSON.stringify({
            ...payload,
            ...(uploadFile ? { sample: true } : {}),
            price: Math.round(Number(draft.price) * 100),
            pages: Number(draft.pages),
            details: draft.details.split("\n").filter(Boolean),
          }),
        },
      );
      if (uploadFile) {
        const format = uploadFile.name.split(".").pop().toLowerCase();
        const response = await fetch(
          `/api/admin/products/${encodeURIComponent(saved.id)}/file`,
          {
            method: "PUT",
            credentials: "same-origin",
            headers: {
              ...headers,
              "Content-Type": "application/octet-stream",
              "X-File-Format": format,
              "X-Content-Rights": "owned-or-licensed",
            },
            body: uploadFile,
          },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || "The private file could not be uploaded.",
          );
        if (!draft.sample)
          await api(`/api/admin/products/${saved.id}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ sample: false }),
          });
      }
      await refresh();
      onStoreUpdate();
      setEditing(null);
      notify("Product updated");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const caption = product
    ? {
        Instagram: `A little clarity. A fresh start.\n\nMeet ${product.title} — ${product.subtitle.toLowerCase().replace(/\.$/, "")}. A digital resource made for your next chapter.\n\nExplore what’s inside at [your store link].\n\n#DigitalProducts #Ebooks #CreativeLife #YourNextLeafivo`,
        Facebook: `What’s one idea you’ve been meaning to make time for?\n\n${product.title} is a practical place to begin. ${product.subtitle}.\n\nSee the full details: [your store link]`,
        TikTok: `Your next chapter starts with one small step. ✳︎\n\nA look inside ${product.title}. Which page would you start with?\n\nExplore via the link in bio.\n#BookTok #DigitalProducts #SmallBusiness`,
        Pinterest: `${product.title} | ${product.subtitle}\n\nSave this for your next fresh start. Explore this digital resource and see what’s included.\n\n[your product link]`,
        LinkedIn: `Ideas are only the beginning. Putting them into practice is where the work happens.\n\nWe’re introducing ${product.title}: ${product.subtitle.toLowerCase().replace(/\.$/, "")}.\n\nExplore the resource and its contents: [your product link]`,
        "YouTube Shorts": `One resource for your next chapter: ${product.title}.\n\nTake a quick look inside, then explore the full product through the link in the description.\n\n#Shorts #DigitalProducts`,
        "Threads / X": `A small resource for your next big idea.\n\n${product.title} — ${product.subtitle.toLowerCase().replace(/\.$/, "")}.\n\nExplore: [your product link]`,
      }[channel]
    : "";
  useEffect(() => setCaptionEdit(null), [channel, productId]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(captionEdit ?? caption);
      notify("Draft caption copied");
    } catch {
      notify("Select the caption text to copy it.");
    }
  };
  const download = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f5f2e9";
    ctx.fillRect(0, 0, 1080, 1080);
    ctx.fillStyle = "#193b31";
    ctx.font = "25px Arial";
    ctx.fillText("LEAFIVO  /  THE DIGITAL COLLECTION", 80, 95);
    ctx.fillStyle =
      {
        sage: "#c5d5b5",
        peach: "#edbb9d",
        blue: "#b8cce4",
        yellow: "#eadb97",
        ink: "#263d35",
        pink: "#e0b9bb",
      }[product.cover] || "#c5d5b5";
    ctx.fillRect(300, 220, 480, 610);
    ctx.fillStyle = product.cover === "ink" ? "#edf1ce" : "#193b31";
    ctx.font = "56px Georgia";
    let y = 340,
      line = "";
    for (const word of product.title.split(" ")) {
      if (ctx.measureText(line + word).width > 370) {
        ctx.fillText(line.trim(), 350, y);
        y += 66;
        line = "";
      }
      line += word + " ";
    }
    ctx.fillText(line.trim(), 350, y);
    ctx.font = "20px Arial";
    ctx.fillText("LEAFIVO EDITIONS", 350, 770);
    ctx.fillStyle = "#193b31";
    ctx.font = "36px Georgia";
    ctx.fillText("Your next chapter starts here.", 80, 950);
    ctx.font = "18px Arial";
    ctx.fillText(
      product.sample
        ? "SAMPLE CREATIVE · REPLACE BEFORE PUBLISHING"
        : "DIGITAL EDITION · EXPLORE THE COLLECTION",
      80,
      1000,
    );
    const a = document.createElement("a");
    a.download = `chapter-${product.id}-social.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  };
  return (
    <main className="studio section-wrap">
      <button className="text-link" onClick={onBack}>
        <ArrowLeft size={16} />
        Back to the shop
      </button>
      <div className="studio-title">
        <div>
          <span className="eyebrow">BEHIND THE LEAFIVO</span>
          <h1>
            Your store studio<span>.</span>
          </h1>
          <p>A little space to manage what’s next.</p>
        </div>
        <span className="mode-chip">
          <i />
          {store.mode === "preview" ? "Preview mode" : "Live mode"}
        </span>
      </div>
      <div className="studio-tabs">
        {[
          { id: "overview", icon: LayoutDashboard, label: "Overview" },
          { id: "catalog", icon: Package, label: "Product catalog" },
          { id: "launch", icon: Megaphone, label: "Launch kit" },
          ...(store.ownerAccess
            ? [{ id: "security", icon: ShieldCheck, label: "Account security" }]
            : []),
        ].map((t) => (
          <button
            className={tab === t.id ? "selected" : ""}
            onClick={() => {
              setTab(t.id);
              setError("");
            }}
            key={t.id}
          >
            <t.icon size={17} />
            {t.label}
          </button>
        ))}
        {auth && (
          <button className="logout-button" onClick={signOut}>
            <LogOut size={16} />
            Sign out
          </button>
        )}
      </div>
      {error && (
        <p className="studio-error" role="alert">
          <AlertCircle size={17} />
          {error}
        </p>
      )}
      {tab === "launch" ? (
        <>
          <div className="studio-intro">
            <h2>A good launch starts with a story.</h2>
            <p>
              Choose a product and a platform. Make these drafts your own before
              sharing.
              <br />
              Nothing is posted automatically, and no advertising money is
              spent.
            </p>
          </div>
          <div className="launch-grid">
            <div className="studio-card">
              <span className="eyebrow">01 / MAKE IT YOURS</span>
              <label className="field-label" htmlFor="social-product">
                Featured product
              </label>
              <select
                className="text-input"
                id="social-product"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <label className="field-label" htmlFor="social-channel">
                Social platform
              </label>
              <select
                className="text-input"
                id="social-channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                {[
                  "Instagram",
                  "Facebook",
                  "TikTok",
                  "Pinterest",
                  "LinkedIn",
                  "YouTube Shorts",
                  "Threads / X",
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <label className="field-label" htmlFor="social-caption">
                Your draft caption
              </label>
              <textarea
                id="social-caption"
                className="text-input caption-input"
                value={captionEdit ?? caption}
                onChange={(e) => setCaptionEdit(e.target.value)}
              />
              <button className="button primary full-width" onClick={copy}>
                <Copy size={16} />
                Copy draft caption
              </button>
              <p className="small-note">
                Replace the link placeholder, check product claims, and remove
                sample branding before posting.
              </p>
            </div>
            <div className="studio-card social-preview-card">
              <span className="eyebrow">02 / SET THE SCENE</span>
              <div className="social-preview">
                <div className="social-brand">LEAFIVO / THE COLLECTION</div>
                {product && <Cover product={product} />}
                <h3>
                  Your next chapter
                  <br />
                  starts here.
                </h3>
                <span>
                  {product?.sample ? "SAMPLE CREATIVE" : "DIGITAL EDITION"}
                </span>
              </div>
              <button
                className="button secondary full-width"
                onClick={download}
                disabled={!product}
              >
                <Download size={17} />
                Download social image
              </button>
              <span className="small-note">
                1080 × 1080 PNG · Pair with your own product screenshots.
              </span>
            </div>
          </div>
          <div className="launch-checklist studio-card">
            <div>
              <span className="eyebrow">BEFORE YOUR BIG HELLO</span>
              <h2>Ready. Set. Launch.</h2>
              <p>Build trust before you buy attention.</p>
            </div>
            <ol>
              <li>
                <span>01</span>Replace sample products with your own content and
                final prices.
              </li>
              <li>
                <span>02</span>Connect payments, verify delivery, and publish
                your business policies.
              </li>
              <li>
                <span>03</span>Publish on your domain and replace all draft
                links.
              </li>
              <li>
                <span>04</span>Choose your audience, approve a budget, and
                measure your first campaign.
              </li>
            </ol>
          </div>
        </>
      ) : store.ownerAccess && sessionLoading ? (
        <div className="admin-login studio-card">
          <LoaderCircle className="spin" size={25} />
          <p>Checking your owner session…</p>
        </div>
      ) : store.ownerAccess && !auth ? (
        <OwnerAccess
          requireFreshLogin={ownerLocked}
          onAuthenticated={(session) => {
            setOwnerLocked(false);
            setError("");
            setAuth(session);
            setTab("overview");
            refresh(session).catch((e) => setError(e.message));
          }}
          onBack={onBack}
          notify={notify}
        />
      ) : store.publicPreview && !store.ownerAccess ? (
        <div className="admin-login studio-card">
          <ShieldCheck size={32} />
          <h2>A first look, just for you.</h2>
          <p>
            Owner tools are disabled in this public preview. Explore the
            collection, try the shopping bag, and visit the launch kit to see
            what’s possible.
          </p>
          <button
            className="button primary full-width"
            onClick={() => setTab("launch")}
          >
            Explore the launch kit <ArrowRight size={17} />
          </button>
        </div>
      ) : !auth ? (
        <div className="admin-login studio-card">
          <ShieldCheck size={32} strokeWidth={1.4} />
          <h2>A space for the owner.</h2>
          <p>
            Sign in with the admin access key configured on your server.
            Customer information and catalog editing are private.
          </p>
          <form onSubmit={login}>
            <label className="field-label" htmlFor="admin-token">
              Admin access key
            </label>
            <input
              id="admin-token"
              type="password"
              className="text-input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
              placeholder="Your private access key"
            />
            <button className="button primary full-width" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <>
                  Open your dashboard <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <p className="small-note">
            Not set up yet? Configure ADMIN_TOKEN in the server environment.
            Never share this key or use it in social posts.
          </p>
        </div>
      ) : tab === "security" && store.ownerAccess ? (
        <OwnerSecurity
          session={auth}
          onSessionUpdate={setAuth}
          onLogout={clearOwner}
          notify={notify}
        />
      ) : tab === "overview" ? (
        <>
          <div className="stats-grid">
            {[
              ["Products", overview?.stats?.products || products.length],
              ["Email signups", overview?.stats?.subscribers || 0],
              ["Sample orders", overview?.stats?.previewOrders || 0],
              ["Paid orders", overview?.stats?.paidOrders || 0],
            ].map(([label, value]) => (
              <div className="studio-card stat" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="studio-card orders-card">
            <div className="section-heading">
              <h2>Recent orders</h2>
              <button
                className="text-link"
                onClick={() => refresh().catch((e) => setError(e.message))}
              >
                Refresh <ArrowRight size={15} />
              </button>
            </div>
            {overview?.orders?.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Customer</th>
                      <th>Status</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.orders.map((o) => (
                      <tr key={o.id}>
                        <td>{o.id.slice(-8).toUpperCase()}</td>
                        <td>{o.email}</td>
                        <td>
                          <span className="status-chip">{o.status}</span>
                        </td>
                        <td>{money(o.total, o.currency || "usd")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-table">
                Your first chapter is still ahead. Orders will appear here.
              </p>
            )}
          </div>
          <div className="studio-card subscribers-card">
            <h2>Email interest list</h2>
            <p className="small-note">
              Latest 50 consented signups. Email sending and unsubscribe
              management are not connected.
            </p>
            {overview?.subscribers?.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Email address</th>
                      <th>Signed up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.subscribers.map((s) => (
                      <tr key={s.email}>
                        <td>{s.email}</td>
                        <td>{new Date(s.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-table">
                Your audience starts with one person. Signups will appear here.
              </p>
            )}
          </div>
          <div className="studio-card">
            <h2>Your launch status</h2>
            <p>
              {store.mode === "preview"
                ? "The store is in preview. Sample orders are unpaid and are not revenue."
                : "Live checkout is enabled. Confirm your payment webhooks and delivery are healthy before running campaigns."}
            </p>
            <p className="small-note">
              Subscribers are stored locally on the server. Connect a compliant
              email platform and an unsubscribe process before sending
              campaigns.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="studio-intro">
            <h2>Good products, thoughtfully presented.</h2>
            <p>
              Edit your catalog. Keep sample products labeled until the real
              files are ready.
            </p>
            <button
              className="button primary"
              onClick={() => {
                setEditing("new");
                setDraft({
                  title: "",
                  subtitle: "",
                  description: "",
                  category: "Ebooks",
                  price: "19",
                  pages: 1,
                  format: "PDF ebook",
                  cover: "sage",
                  featured: false,
                  sample: true,
                  details: "",
                });
              }}
            >
              Add a product <Plus size={17} />
            </button>
          </div>
          <div className="admin-product-list">
            {(overview?.products || products).map((p) => (
              <div className="studio-card admin-product" key={p.id}>
                <div className={`mini-cover product-bg-${p.cover}`}>
                  <Cover product={p} />
                </div>
                <div>
                  <span className="eyebrow">
                    {p.category} · {p.sample ? "SAMPLE" : "REAL PRODUCT"}
                  </span>
                  <h3>{p.title}</h3>
                  <p>{p.subtitle}</p>
                </div>
                <strong>{money(p.price, p.currency)}</strong>
                <button
                  className="button secondary"
                  onClick={() => {
                    setEditing(p.id);
                    setDraft({
                      ...p,
                      price: (p.price / 100).toString(),
                      details: p.details.join("\n"),
                    });
                  }}
                >
                  Edit product <ArrowUpRight size={15} />
                </button>
                <button
                  className="delete-product icon-button"
                  aria-label={`Delete ${p.title}`}
                  onClick={() => setDeleting(p)}
                >
                  <X size={17} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {deleting && (
        <Modal
          onClose={() => setDeleting(null)}
          label="Delete product"
          className="info-modal"
        >
          <span className="eyebrow">REMOVE A LISTING</span>
          <h2>Close this chapter?</h2>
          <p>
            Remove {deleting.title} from the store? Past orders and private
            files will be kept.
          </p>
          <button
            className="button primary full-width"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/admin/products/${deleting.id}`, {
                  method: "DELETE",
                  headers,
                });
                await refresh();
                onStoreUpdate();
                setDeleting(null);
                notify("Product listing removed");
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove listing <X size={17} />
          </button>
          <button
            className="text-link continue-shopping"
            onClick={() => setDeleting(null)}
          >
            Keep this product
          </button>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
      {editing && draft && (
        <Modal
          onClose={() => setEditing(null)}
          label="Edit product"
          className="info-modal edit-modal"
        >
          <span className="eyebrow">THE PRODUCT DETAILS</span>
          <h2>Make it yours.</h2>
          <form onSubmit={save}>
            {[
              ["title", "Product title"],
              ["subtitle", "Short subtitle"],
              ["price", "Price (USD)"],
              ["pages", "Number of pages"],
              ["format", "File format"],
            ].map(([key, label]) => (
              <label className="field-label" key={key}>
                {label}
                <input
                  className="text-input"
                  value={draft[key]}
                  type={["price", "pages"].includes(key) ? "number" : "text"}
                  min={key === "price" ? "0.50" : "1"}
                  step={key === "price" ? "0.01" : "1"}
                  required
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <label className="field-label">
              Category
              <select
                className="text-input"
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value })
                }
              >
                {["Ebooks", "Templates", "Bundles"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Cover color
              <select
                className="text-input"
                value={draft.cover}
                onChange={(e) => setDraft({ ...draft, cover: e.target.value })}
              >
                {["sage", "peach", "yellow", "blue", "ink", "pink"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Description
              <textarea
                className="text-input"
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                required
              />
            </label>
            <label className="field-label">
              What’s included (one item per line)
              <textarea
                className="text-input"
                value={draft.details}
                onChange={(e) =>
                  setDraft({ ...draft, details: e.target.value })
                }
              />
            </label>
            {store.ownerAccess ? (
              <div className="owner-file-upload">
                <label className="field-label" htmlFor="owner-product-file">
                  Private ebook or product file
                  <input
                    id="owner-product-file"
                    className="text-input"
                    type="file"
                    accept=".pdf,.epub,.zip"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  />
                </label>
                <p className="small-note">
                  PDF, EPUB or ZIP · up to 25 MB. Files stay private. Header
                  checks do not replace checking your files for malware.
                </p>
                {draft.downloadReady && editing !== "new" && (
                  <a
                    className="text-link"
                    href={`/api/admin/products/${editing}/file`}
                    download
                  >
                    Review current private file <Download size={15} />
                  </a>
                )}
                {uploadFile && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={uploadRights}
                      onChange={(e) => setUploadRights(e.target.checked)}
                      required
                    />
                    I own this content or have permission to distribute it.
                  </label>
                )}
              </div>
            ) : (
              <>
                <label className="field-label">
                  Private download filename (optional)
                  <input
                    className="text-input"
                    placeholder="my-ebook.pdf"
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        downloadFile: e.target.value || null,
                      })
                    }
                  />
                  <span className="small-note">
                    Place the owned file in the server’s private downloads
                    directory first. Never put it in public/.
                  </span>
                </label>
              </>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.sample}
                onChange={(e) =>
                  setDraft({ ...draft, sample: e.target.checked })
                }
              />
              This is a sample product
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.featured}
                onChange={(e) =>
                  setDraft({ ...draft, featured: e.target.checked })
                }
              />
              Feature in the collection
            </label>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button className="button primary full-width" disabled={busy}>
              {busy ? "Saving…" : "Save product"}
              <Check size={17} />
            </button>
          </form>
        </Modal>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
