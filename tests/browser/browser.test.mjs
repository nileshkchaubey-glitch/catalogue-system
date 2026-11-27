import assert from "node:assert/strict";
import test from "node:test";
import { launchChromium, waitFor } from "./chromium.mjs";
import { createLocalFixture, owners, photo, photoRoute } from "./local-fixture.mjs";
import { applyBulkMarkup, buildBulkPreview, buildQuoteSnapshot } from "../../shared/quote-pricing.mjs";

function loginRequest(app, owner, origin = app.origin) {
  return app.request("/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: owner.password }),
  });
}

function cookieHeader(response) {
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) {
    assert.match(cookie, /^catalogue_(access|refresh)=/);
    assert.match(cookie, /; HttpOnly\b/);
    assert.match(cookie, /; SameSite=Lax\b/);
  }
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

test("Packaged Worker authorizes synthetic owners, protects media, and rejects stale saves", { timeout: 15000 }, async (t) => {
  const app = await createLocalFixture(t);
  for (const path of ["/api/session", "/api/workspace", "/api/buyer", photoRoute])
    assert.equal((await app.request(path)).status, 401, path);
  for (const [path, method] of [["/api/photos", "POST"], ["/api/workspace", "PUT"]]) {
    const response = await app.request(path, { method, headers: { Origin: app.origin }, body: "" });
    assert.equal(response.status, 401, method + " " + path);
  }
  assert.equal(app.audit.length, 0);
  assert.equal((await loginRequest(app, owners.desktop, "http://unrelated.example.invalid")).status, 403);
  assert.equal((await app.request("/api/signup", { method: "POST", headers: { Origin: app.origin } })).status, 404);
  assert.equal((await loginRequest(app, { ...owners.desktop, password: "incorrect" })).status, 401);
  assert.equal((await loginRequest(app, owners.unprovisioned)).status, 403);
  assert.equal((await app.request("/api/workspace", { headers: { Cookie: "catalogue_access=invalid-fixture-token" } })).status, 401);

  const desktop = await loginRequest(app, owners.desktop);
  assert.equal(desktop.status, 200);
  const desktopHeaders = { Cookie: cookieHeader(desktop) };
  const desktopProfile = await desktop.json();
  assert.equal(desktopProfile.profile.business_name, "Desktop Fixture Studio");
  assert.equal(JSON.stringify(desktopProfile).includes("fixture-access-"), false);

  const ownPhoto = await app.request(photoRoute, { headers: desktopHeaders });
  assert.equal(ownPhoto.status, 200);
  assert.equal(ownPhoto.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Buffer.from(await ownPhoto.arrayBuffer()), photo);
  const buyer = await app.request("/api/buyer", { headers: desktopHeaders });
  assert.equal(buyer.status, 200);
  const { products } = await buyer.json();
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "Desktop fixture tray");
  assert.deepEqual(Object.keys(products[0]).sort(), [
    "category", "familyId", "gallery", "id", "name", "photo", "unit", "variant",
  ]);

  const mobile = await loginRequest(app, owners.mobile);
  assert.equal(mobile.status, 200);
  const mobileHeaders = { Cookie: cookieHeader(mobile) };
  const { profile: mobileProfile } = await mobile.json();
  const mobileWorkspace = await app.request("/api/workspace?owner_id=" + owners.desktop.id, { headers: mobileHeaders });
  assert.equal(mobileWorkspace.status, 200);
  assert.equal(mobileWorkspace.headers.get("X-Revision"), "new");
  assert.deepEqual((await mobileWorkspace.json()).families, []);
  assert.equal((await app.request(photoRoute, { headers: mobileHeaders })).status, 404);
  const upload = await app.request("/api/photos", {
    method: "POST",
    headers: { ...mobileHeaders, Origin: app.origin, "Content-Type": "image/jpeg", "X-Owner-Profile": mobileProfile.id },
    body: photo,
  });
  assert.equal(upload.status, 200);
  assert.equal((await upload.json()).photo, photoRoute);
  assert.equal((await app.request(photoRoute, { headers: mobileHeaders })).status, 200);

  const read = await app.request("/api/workspace", { headers: desktopHeaders });
  assert.equal(read.status, 200);
  const revision = read.headers.get("X-Revision");
  const document = await read.json();
  document.customers.push({
    id: "signed-in-fixture",
    name: "Signed-in Fixture Buyer",
    phone: "000000000",
    collection: "Full catalog",
    consent: false,
  });
  const update = (profileId = desktopProfile.profile.id) => app.request("/api/workspace", {
    method: "PUT",
    headers: { ...desktopHeaders, Origin: app.origin, "Content-Type": "application/json", "X-Revision": revision,
      "X-Owner-Profile": profileId },
    body: JSON.stringify(document),
  });
  assert.equal((await update(mobileProfile.id)).status, 403);
  const concurrent = await Promise.all([update(), update()]);
  assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 409]);
  assert.equal((await update()).status, 409);
  assert.deepEqual(app.rows.get(owners.desktop.id).document.customers, document.customers);
  assert.equal(app.rows.has(owners.mobile.id), false);
  const signOut = await app.request("/api/session", {
    method: "DELETE",
    headers: { ...desktopHeaders, Origin: app.origin },
  });
  assert.equal(signOut.status, 204);
  assert.ok(signOut.headers.getSetCookie().every((cookie) => cookie.includes("Max-Age=0")));
  assert.equal((await app.request("/api/workspace", { headers: desktopHeaders })).status, 403);
  assert.equal((await update()).status, 403);
  const refreshCookie = desktopHeaders.Cookie.split("; ").find((value) => value.startsWith("catalogue_refresh="));
  assert.equal((await app.request("/api/session", { headers: { Cookie: refreshCookie } })).status, 401);
  assert.ok(app.audit.some(({ pathname, method }) => pathname === "/rest/v1/rpc/save_catalogue_workspace" && method === "POST"));
  assert.ok(app.audit.filter(({ pathname }) => pathname === "/rest/v1/catalogue_workspaces").every(({ method }) => method === "GET"));
});

test("Packaged Worker rotates an expired session and preserves confirmed quotations", { timeout: 15000 }, async (t) => {
  const app = await createLocalFixture(t);
  const login = await loginRequest(app, owners.desktop);
  assert.equal(login.status, 200);
  const oldCookies = cookieHeader(login);
  const oldRefresh = oldCookies.split("; ").find((value) => value.startsWith("catalogue_refresh="));
  const session = await app.request("/api/session", { headers: { Cookie: oldRefresh } });
  assert.equal(session.status, 200);
  const cookies = cookieHeader(session);
  assert.notEqual(cookies, oldCookies);
  const { profile } = await session.json();
  assert.equal((await app.request("/api/workspace", {
    headers: { Cookie: cookies, "X-Owner-Profile": owners.mobile.id },
  })).status, 403);

  const read = await app.request("/api/workspace", { headers: { Cookie: cookies } });
  let revision = read.headers.get("X-Revision");
  const first = await read.json();
  const variant = first.families[0].variants[0];
  const customer = { id: "quote-customer", name: "Quote Fixture Buyer", phone: "000000001", collection: "Full catalog", consent: true };
  const draft = { id: "fixture-quote", customerId: customer.id, lines: [{ variantId: variant.id, quantity: "3", rateOverride: "8.03" }] };
  async function save(document, expectedStatus = 200) {
    const response = await app.request("/api/workspace", {
      method: "PUT",
      headers: {
        Cookie: cookies, Origin: app.origin, "Content-Type": "application/json",
        "X-Owner-Profile": profile.id, "X-Revision": revision,
      },
      body: JSON.stringify(document),
    });
    assert.equal(response.status, expectedStatus);
    const result = await response.json();
    if (response.ok) revision = result.revision;
    return result.workspace;
  }

  const savedDraft = await save({ ...first, customers: [customer], quoteDrafts: [draft] });
  const snapshot = buildQuoteSnapshot(savedDraft, draft, "2026-11-27T00:00:00.000Z");
  const confirmation = { ...savedDraft, quoteDrafts: [], quoteSnapshots: [snapshot] };
  const mixedSave = structuredClone(confirmation);
  mixedSave.families[0].variants[0].history = [];
  await save(mixedSave, 422);
  const confirmed = await save(confirmation);
  assert.equal(confirmed.families[0].variants[0].rate, "10.00");
  assert.deepEqual(confirmed.families[0].variants[0].history, variant.history);
  assert.equal(confirmed.quoteSnapshots[0].total, "24.09");
  assert.equal(Object.hasOwn(confirmed.quoteSnapshots[0].lines[0], "purchase"), false);
  await save({ ...confirmed, quoteSnapshots: [] }, 422);

  const preview = buildBulkPreview(confirmed, [variant.id], "25.50");
  const updated = await save(applyBulkMarkup(confirmed, preview, "2026-11-27T01:00:00.000Z"));
  assert.deepEqual(updated.quoteSnapshots, [snapshot]);
  assert.deepEqual(updated.families[0].variants[0].history.map((entry) => entry.rate), ["10.00", "6.28"]);
});

const byText = (selector, label) => `[...document.querySelectorAll(${JSON.stringify(selector)})]
  .find(element => element.textContent.trim() === ${JSON.stringify(label)} && element.getClientRects().length && !element.disabled)`;
const button = (label) => byText("button", label);
const heading = (label) => byText("h1", label);
const rendered = (value) => `document.body?.innerText.includes(${JSON.stringify(value)})`;

async function expectVisible(page, expression, description) {
  await waitFor(() => page.visible(expression), description);
}

async function signInFromKeyboard(page, owner) {
  await expectVisible(page, heading("Admin sign in"), "admin sign-in");
  await page.focus('document.querySelector("input[name=email]")');
  await page.type(owner.email);
  await page.key("Tab");
  assert.equal(await page.evaluate("document.activeElement.name"), "password");
  await page.type(owner.password);
  await page.key("Enter");
  await expectVisible(page, button("Sign out"), "signed-in workspace");
}

async function addCustomer(page, name) {
  const add = button("Add customer");
  await page.click(button("Customers"));
  await expectVisible(page, heading("Customers"), "Customers page");
  await page.focus(add);
  await page.key("Enter");
  await expectVisible(page, 'document.querySelector("dialog[open]")', "customer dialog opened from Enter");
  await page.key("Escape");
  await waitFor(async () => !(await page.visible('document.querySelector("dialog[open]")')), "Escape closes customer dialog");
  assert.equal(await page.visible('document.activeElement.textContent.trim() === "Add customer"'), true);

  await page.click(add);
  await page.focus('document.querySelector("dialog[open] input[type=tel]")?.form.querySelector("input")');
  await page.type(name);
  await page.key("Tab");
  assert.equal(await page.evaluate("document.activeElement.type"), "tel");
  await page.type("000000000");
  await page.key("Tab");
  assert.equal(await page.evaluate("document.activeElement.tagName"), "SELECT");
  await page.key("Tab");
  assert.equal(await page.evaluate("document.activeElement.type"), "checkbox");
  await page.key("Space");
  assert.equal(await page.evaluate("document.activeElement.checked"), true);
  await page.key("Tab");
  await page.key("Tab");
  assert.equal(await page.evaluate("document.activeElement.textContent.trim()"), "Save customer");
  await page.key("Enter");
  await expectVisible(page, rendered(name), "saved customer row");
  await waitFor(async () => !(await page.visible('document.querySelector("dialog[open]")')), "saved dialog closes");
  assert.equal(await page.visible('document.activeElement.textContent.trim() === "Add customer"'), true);
}

test("Chromium desktop and mobile owner workflows with synthetic Supabase", { timeout: 40000 }, async (t) => {
  const app = await createLocalFixture(t);
  const browser = await launchChromium();
  t.after(() => browser.close());
  t.diagnostic(browser.version);

  for (const viewport of [
    { owner: owners.desktop, width: 1366, height: 900, label: "Desktop fixture customer" },
    { owner: owners.mobile, width: 390, height: 844, mobile: true, label: "Mobile fixture customer" },
  ]) {
    await t.test(viewport.width + "x" + viewport.height + (viewport.mobile ? " touch" : " desktop"), { timeout: 15000 }, async (layout) => {
      const page = await browser.newPage(app.origin, viewport);
      layout.after(() => page.close());
      await page.navigate();
      await expectVisible(page, heading("Admin sign in"), "private entry point");
      assert.equal(await page.visible(button("Customers")), false);
      assert.equal(await page.evaluate("innerWidth"), viewport.width);
      assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      assert.equal(await page.evaluate('fetch("/api/workspace").then(r => r.status)'), 401);
      assert.equal(await page.evaluate(`fetch(${JSON.stringify(photoRoute)}).then(r => r.status)`), 401);
      await signInFromKeyboard(page, viewport.owner);
      assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      await addCustomer(page, viewport.label);
      assert.ok(app.rows.get(viewport.owner.id).document.customers.some((customer) =>
        customer.name === viewport.label && customer.consent));

      await page.navigate();
      await expectVisible(page, button("Sign out"), "session restored on reload");
      await page.click(button("Customers"));
      await expectVisible(page, rendered(viewport.label), "saved customer restored on reload");
      if (viewport.mobile) {
        assert.equal(await page.visible(rendered("Desktop fixture customer")), false);
        assert.equal(await page.evaluate(`fetch(${JSON.stringify(photoRoute)}).then(r => r.status)`), 404);
      }
      assert.equal(await page.evaluate('document.cookie.includes("catalogue_")'), false);
      await page.click(button("Sign out"));
      await expectVisible(page, heading("Admin sign in"), "logout returns to sign-in");
      assert.equal(await page.evaluate('fetch("/api/workspace").then(r => r.status)'), 401);
      assert.deepEqual(page.outside, []);
      assert.deepEqual(page.errors, []);
    });
  }
});
