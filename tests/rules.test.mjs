// Security-rule tests. Run from the repo root:
//   npx firebase emulators:exec --only firestore --project demo-shiftpunch "node tests/rules.test.mjs"
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, writeBatch } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "demo-shiftpunch",
  firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
});

const as = (uid, email, verified = true) => env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const lead = as("lead", "boss@example.com");
const ann = as("ann", "ann@example.com");
const annUnverified = as("ann", "ann@example.com", false);
const bob = as("bob", "bob@example.com");
const cat = as("cat", "cat@example.com");
const anon = env.unauthenticatedContext().firestore();

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.message || e)); }
}

const GID = "g1";
const mid = (email) => `${GID}_${email}`;
const invite = (email, leaderUid = "lead", leaderEmail = "boss@example.com") =>
  ({ gid: GID, groupName: "Front desk", email, leaderUid, leaderEmail, status: "invited", uid: null, rate: 15 });
const accept = (db, uid, email) => updateDoc(doc(db, "memberships/" + mid(email)), { status: "joined", uid, name: uid, joinedAt: 1 });
const grant = (db, leaderUid, memberUid, email) => setDoc(doc(db, `access/${memberUid}_${leaderUid}`), { leaderUid, memberUid, mid: mid(email) });

// ---------------------------------------------------------------- basics
await t("each person can write their own punches", async () => {
  for (const [db, uid] of [[ann, "ann"], [bob, "bob"], [lead, "lead"], [cat, "cat"]]) {
    await assertSucceeds(setDoc(doc(db, `users/${uid}/days/2026-11-03`), { events: [{ t: "in", at: 1 }] }));
    await assertSucceeds(setDoc(doc(db, `users/${uid}`), { name: uid, rate: 15 }));
  }
});
await t("signed-out visitors can read nothing", () => assertFails(getDoc(doc(anon, "users/ann/days/2026-11-03"))));
await t("someone else cannot read your punches", () => assertFails(getDoc(doc(bob, "users/ann/days/2026-11-03"))));
await t("someone else cannot write your punches", () => assertFails(setDoc(doc(bob, "users/ann/days/2026-11-04"), { events: [] })));

// ---------------------------------------------------------------- groups and invites
await t("anyone signed in can start a group they lead", () => assertSucceeds(setDoc(doc(lead, "groups/" + GID), { name: "Front desk", leaderUid: "lead", leaderEmail: "boss@example.com" })));
await t("cannot start a group naming someone else leader", () => assertFails(setDoc(doc(bob, "groups/g2"), { name: "X", leaderUid: "lead" })));
await t("leader can invite by email", async () => {
  await assertSucceeds(setDoc(doc(lead, "memberships/" + mid("ann@example.com")), invite("ann@example.com")));
  await assertSucceeds(setDoc(doc(lead, "memberships/" + mid("bob@example.com")), invite("bob@example.com")));
  await assertSucceeds(setDoc(doc(lead, "memberships/" + mid("cat@example.com")), invite("cat@example.com")));
});
await t("non-leader cannot invite into the group", () => assertFails(setDoc(doc(bob, "memberships/" + mid("zed@example.com")), invite("zed@example.com", "bob"))));
await t("leader cannot add someone as already joined", () => assertFails(setDoc(doc(lead, "memberships/" + mid("zed@example.com")), { ...invite("zed@example.com"), status: "joined", uid: "zed" })));
await t("invited person sees their invite", () => assertSucceeds(getDocs(query(collection(ann, "memberships"), where("email", "==", "ann@example.com")))));
await t("others cannot list someone's invites", () => assertFails(getDocs(query(collection(bob, "memberships"), where("email", "==", "ann@example.com")))));
await t("leader lists their memberships and groups", async () => {
  await assertSucceeds(getDocs(query(collection(lead, "memberships"), where("leaderUid", "==", "lead"))));
  await assertSucceeds(getDocs(query(collection(lead, "groups"), where("leaderUid", "==", "lead"))));
});
await t("invited person can read the group; a stranger cannot", async () => {
  await assertSucceeds(getDoc(doc(ann, "groups/" + GID)));
  await assertFails(getDoc(doc(as("zed", "zed@example.com"), "groups/" + GID)));
});

// ---------------------------------------------------------------- joining and viewing
await t("leader cannot read punches before the invite is accepted", async () => {
  await assertSucceeds(grant(lead, "lead", "ann", "ann@example.com"));
  await assertFails(getDoc(doc(lead, "users/ann/days/2026-11-03")));
});
await t("unverified email cannot accept an invite", () => assertFails(accept(annUnverified, "ann", "ann@example.com")));
await t("someone else cannot accept your invite", () => assertFails(updateDoc(doc(bob, "memberships/" + mid("ann@example.com")), { status: "joined", uid: "bob" })));
await t("invited people accept", async () => {
  await assertSucceeds(accept(ann, "ann", "ann@example.com"));
  await assertSucceeds(accept(bob, "bob", "bob@example.com"));
});
await t("leader can read a member's punches after they join", async () => {
  await assertSucceeds(grant(lead, "lead", "bob", "bob@example.com"));
  await assertSucceeds(getDoc(doc(lead, "users/ann/days/2026-11-03")));
  await assertSucceeds(getDocs(collection(lead, "users/ann/days")));
});
await t("leader cannot change a member's punches or read their settings", async () => {
  await assertFails(setDoc(doc(lead, "users/ann/days/2026-11-03"), { events: [] }));
  await assertFails(getDoc(doc(lead, "users/ann")));
});
await t("leader can set the member's pay rate, nothing else", async () => {
  await assertSucceeds(updateDoc(doc(lead, "memberships/" + mid("ann@example.com")), { rate: 17.5 }));
  await assertFails(updateDoc(doc(lead, "memberships/" + mid("ann@example.com")), { uid: "lead" }));
});
await t("member cannot change their own pay rate on the group", () => assertFails(updateDoc(doc(ann, "memberships/" + mid("ann@example.com")), { rate: 99 })));
await t("a fake access pointer grants nothing", async () => {
  // bob points a pointer from ann to himself; ann's membership names the boss, not bob
  await assertSucceeds(setDoc(doc(bob, "access/ann_bob"), { leaderUid: "bob", memberUid: "ann", mid: mid("ann@example.com") }));
  await assertFails(getDoc(doc(bob, "users/ann/days/2026-11-03")));
  await assertFails(setDoc(doc(bob, "access/ann_lead"), { leaderUid: "lead", memberUid: "ann", mid: "x" }));
});

// ---------------------------------------------------------------- handing off the group
const offer = (db, uid, email, keepOld = true) => updateDoc(doc(db, "groups/" + GID), { pendingLeaderUid: uid, pendingLeaderEmail: email, pendingKeepOld: keepOld });
await t("leader cannot offer the group to someone who only has an invite", () => assertFails(offer(lead, "cat", "cat@example.com")));
await t("leader cannot offer the group to a stranger", () => assertFails(offer(lead, "zed", "zed@example.com")));
await t("leader cannot offer the group under the wrong email", () => assertFails(offer(lead, "bob", "ann@example.com")));
await t("leader cannot simply hand leaderUid to someone", () => assertFails(updateDoc(doc(lead, "groups/" + GID), { leaderUid: "bob" })));
await t("a member cannot offer the group to themselves", () => assertFails(offer(bob, "bob", "bob@example.com")));
await t("leader offers the group to a joined member", () => assertSucceeds(offer(lead, "bob", "bob@example.com")));
await t("the person offered can list the group's members", () => assertSucceeds(getDocs(query(collection(bob, "memberships"), where("gid", "==", GID)))));
await t("other members cannot list the group's members", () => assertFails(getDocs(query(collection(ann, "memberships"), where("gid", "==", GID)))));
await t("the person offered can read the group", () => assertSucceeds(getDocs(query(collection(bob, "groups"), where("pendingLeaderUid", "==", "bob")))));
await t("someone else cannot accept the handoff", () => assertFails(updateDoc(doc(ann, "groups/" + GID), { leaderUid: "ann", leaderEmail: "ann@example.com", pendingLeaderUid: null, pendingLeaderEmail: null, pendingKeepOld: null })));
await t("the person offered can turn it down", async () => {
  await assertSucceeds(updateDoc(doc(bob, "groups/" + GID), { pendingLeaderUid: null, pendingLeaderEmail: null, pendingKeepOld: null }));
  await assertSucceeds(offer(lead, "bob", "bob@example.com"));
});
await t("leader can cancel an offer", async () => {
  await assertSucceeds(updateDoc(doc(lead, "groups/" + GID), { pendingLeaderUid: null, pendingLeaderEmail: null, pendingKeepOld: null }));
  await assertSucceeds(offer(lead, "bob", "bob@example.com"));
});
await t("the new leader cannot repoint memberships without taking the group", () =>
  assertFails(updateDoc(doc(bob, "memberships/" + mid("ann@example.com")), { leaderUid: "bob", leaderEmail: "bob@example.com" })));

const takeOver = (db) => {
  const b = writeBatch(db);
  b.update(doc(db, "groups/" + GID), { leaderUid: "bob", leaderEmail: "bob@example.com", pendingLeaderUid: null, pendingLeaderEmail: null, pendingKeepOld: null });
  b.update(doc(db, "memberships/" + mid("ann@example.com")), { leaderUid: "bob", leaderEmail: "bob@example.com" });
  b.update(doc(db, "memberships/" + mid("cat@example.com")), { leaderUid: "bob", leaderEmail: "bob@example.com" });
  b.delete(doc(db, "memberships/" + mid("bob@example.com")));
  b.set(doc(db, "access/ann_bob"), { leaderUid: "bob", memberUid: "ann", mid: mid("ann@example.com") });
  b.set(doc(db, "memberships/" + mid("boss@example.com")), invite("boss@example.com", "bob", "bob@example.com"));
  return b.commit();
};
await t("someone removed from the group cannot accept an old offer", async () => {
  const m = mid("bob@example.com");
  const saved = (await getDoc(doc(lead, "memberships/" + m))).data();
  await env.withSecurityRulesDisabled(async (c) => { await deleteDoc(doc(c.firestore(), "memberships/" + m)); });
  await assertFails(updateDoc(doc(bob, "groups/" + GID), { leaderUid: "bob", leaderEmail: "bob@example.com", pendingLeaderUid: null, pendingLeaderEmail: null, pendingKeepOld: null }));
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), "memberships/" + m), saved); });
});
await t("unconfirmed email cannot accept the handoff", () => assertFails(takeOver(as("bob", "bob@example.com", false))));
await t("the person offered accepts and becomes leader", () => assertSucceeds(takeOver(bob)));
await t("the new leader can read members' punches", () => assertSucceeds(getDocs(collection(bob, "users/ann/days"))));
await t("the old leader can no longer read members' punches", () => assertFails(getDocs(collection(lead, "users/ann/days"))));
await t("the old leader can no longer change rates or remove people", async () => {
  await assertFails(updateDoc(doc(lead, "memberships/" + mid("ann@example.com")), { rate: 1 }));
  await assertFails(deleteDoc(doc(lead, "memberships/" + mid("ann@example.com"))));
  await assertFails(deleteDoc(doc(lead, "groups/" + GID)));
});
await t("the old leader cannot take the group back", () => assertFails(updateDoc(doc(lead, "groups/" + GID), { leaderUid: "lead", leaderEmail: "boss@example.com" })));
await t("the old leader can accept the invite to stay as a member", async () => {
  await assertSucceeds(accept(lead, "lead", "boss@example.com"));
  await assertSucceeds(grant(bob, "bob", "lead", "boss@example.com"));
  await assertSucceeds(getDoc(doc(bob, "users/lead/days/2026-11-03")));
});

// ---------------------------------------------------------------- leaving and removal
await t("after the leader removes a member, punches are private again", async () => {
  await assertSucceeds(deleteDoc(doc(bob, "memberships/" + mid("ann@example.com"))));
  await assertFails(getDoc(doc(bob, "users/ann/days/2026-11-03")));
});
await t("a member can leave a group", async () => {
  await assertSucceeds(deleteDoc(doc(lead, "memberships/" + mid("boss@example.com"))));
  await assertFails(getDoc(doc(bob, "users/lead/days/2026-11-03")));
});
await t("only the leader can delete the group", async () => {
  await assertFails(deleteDoc(doc(ann, "groups/" + GID)));
  await assertSucceeds(deleteDoc(doc(bob, "groups/" + GID)));
});

await env.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
