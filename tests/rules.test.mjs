// Security-rule tests. Run from the repo root:
//   npx firebase emulators:exec --only firestore --project demo-shiftpunch "node tests/rules.test.mjs"
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, writeBatch, deleteField } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "demo-shiftpunch",
  firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
});

const as = (uid, email, verified = true) => env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const lead = as("lead", "boss@example.com");
const ann = as("ann", "ann@example.com");
const annUnverified = as("ann", "ann@example.com", false);
const bob = as("bob", "bob@example.com");
const anon = env.unauthenticatedContext().firestore();

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.message || e)); }
}

const GID = "g1", MID = "g1_ann@example.com";

await t("each person can write their own punches", async () => {
  await assertSucceeds(setDoc(doc(ann, "users/ann/days/2026-11-03"), { events: [{ t: "in", at: 1 }] }));
  await assertSucceeds(setDoc(doc(ann, "users/ann"), { name: "Ann", rate: 15 }));
  await assertSucceeds(setDoc(doc(lead, "users/lead"), { name: "Boss", rate: 15 }));
});
await t("signed-out visitors can read nothing", () => assertFails(getDoc(doc(anon, "users/ann/days/2026-11-03"))));
await t("someone else cannot read your punches", () => assertFails(getDoc(doc(bob, "users/ann/days/2026-11-03"))));
await t("someone else cannot write your punches", () => assertFails(setDoc(doc(bob, "users/ann/days/2026-11-04"), { events: [] })));

await t("anyone signed in can start a group they lead", () => assertSucceeds(setDoc(doc(lead, "groups/" + GID), { name: "Front desk", leaderUid: "lead" })));
await t("cannot start a group naming someone else leader", () => assertFails(setDoc(doc(bob, "groups/g2"), { name: "X", leaderUid: "lead" })));

const invite = { gid: GID, groupName: "Front desk", email: "ann@example.com", leaderUid: "lead", leaderEmail: "boss@example.com", status: "invited", uid: null, rate: 15 };
await t("leader can invite by email", () => assertSucceeds(setDoc(doc(lead, "memberships/" + MID), invite)));
await t("non-leader cannot invite into the group", () => assertFails(setDoc(doc(bob, "memberships/g1_bob@example.com"), { ...invite, email: "bob@example.com", leaderUid: "bob" })));
await t("leader cannot add someone as already joined", () => assertFails(setDoc(doc(lead, "memberships/g1_bob@example.com"), { ...invite, email: "bob@example.com", status: "joined", uid: "bob" })));

await t("invited person sees their invite", () => assertSucceeds(getDocs(query(collection(ann, "memberships"), where("email", "==", "ann@example.com")))));
await t("others cannot list someone's invites", () => assertFails(getDocs(query(collection(bob, "memberships"), where("email", "==", "ann@example.com")))));
await t("leader lists their memberships", () => assertSucceeds(getDocs(query(collection(lead, "memberships"), where("leaderUid", "==", "lead")))));
await t("leader lists groups they lead", () => assertSucceeds(getDocs(query(collection(lead, "groups"), where("leaderUid", "==", "lead")))));
await t("invited person can read the group", () => assertSucceeds(getDoc(doc(ann, "groups/" + GID))));
await t("stranger cannot read the group", () => assertFails(getDoc(doc(bob, "groups/" + GID))));

await t("leader cannot read punches before the invite is accepted", () => assertFails(getDoc(doc(lead, "users/ann/days/2026-11-03"))));

const accept = (db) => { const b = writeBatch(db); b.update(doc(db, "memberships/" + MID), { status: "joined", uid: "ann", name: "Ann", joinedAt: 1 }); b.set(doc(db, "users/ann"), { leaders: { lead: MID } }, { merge: true }); return b.commit(); };
await t("unverified email cannot accept an invite", () => assertFails(accept(annUnverified)));
await t("someone else cannot accept your invite", () => assertFails(updateDoc(doc(bob, "memberships/" + MID), { status: "joined", uid: "bob" })));
await t("invited person accepts", () => assertSucceeds(accept(ann)));

await t("leader can read a member's punches after they join", () => assertSucceeds(getDoc(doc(lead, "users/ann/days/2026-11-03"))));
await t("leader can list all of a member's days", () => assertSucceeds(getDocs(collection(lead, "users/ann/days"))));
await t("leader cannot change a member's punches", () => assertFails(setDoc(doc(lead, "users/ann/days/2026-11-03"), { events: [] })));
await t("leader cannot read a member's settings doc", () => assertFails(getDoc(doc(lead, "users/ann"))));
await t("leader can set the member's pay rate", () => assertSucceeds(updateDoc(doc(lead, "memberships/" + MID), { rate: 17.5 })));
await t("leader cannot flip the member's status or owner", () => assertFails(updateDoc(doc(lead, "memberships/" + MID), { uid: "lead" })));
await t("member cannot change their own pay rate on the group", () => assertFails(updateDoc(doc(ann, "memberships/" + MID), { rate: 99 })));

await t("a stranger who fakes a leaders entry still cannot read", async () => {
  await assertSucceeds(setDoc(doc(bob, "users/bob/days/2026-11-03"), { events: [] }));
  await assertSucceeds(setDoc(doc(bob, "users/bob"), { leaders: { lead: MID } }));
  // bob points at ann's membership; it names ann, so the boss still can't read bob,
  // and bob can't read ann by pointing his own doc at anything.
  await assertFails(getDoc(doc(lead, "users/bob/days/2026-11-03")));
  await assertFails(getDoc(doc(bob, "users/ann/days/2026-11-03")));
});

await t("after the leader removes a member, punches are private again", async () => {
  await assertSucceeds(deleteDoc(doc(lead, "memberships/" + MID)));
  await assertFails(getDoc(doc(lead, "users/ann/days/2026-11-03")));
});

await t("a member can leave a group", async () => {
  await assertSucceeds(setDoc(doc(lead, "memberships/" + MID), invite));
  await assertSucceeds(accept(ann));
  const b = writeBatch(ann); b.delete(doc(ann, "memberships/" + MID)); b.update(doc(ann, "users/ann"), { ["leaders.lead"]: deleteField() });
  await assertSucceeds(b.commit());
  await assertFails(getDoc(doc(lead, "users/ann/days/2026-11-03")));
});

await t("only the leader can delete the group", async () => {
  await assertFails(deleteDoc(doc(bob, "groups/" + GID)));
  await assertSucceeds(deleteDoc(doc(lead, "groups/" + GID)));
});

await env.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
